// Copyright (c) 2018-2019 Zano Project
// Copyright (c) 2018-2019 Hyle Team
// Kusari: the PoW is Monero's RandomX instead of Zano's ProgPoWZ, so blocks are mined on ordinary CPUs.
// Distributed under the MIT/X11 software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.


#include "include_base_utils.h"
using namespace epee;

#include <atomic>
#include <cstdlib>
#include <mutex>
#include <shared_mutex>
#include <thread>
#include <vector>

#include "basic_pow_helpers.h"
#include "currency_format_utils.h"
#include "serialization/binary_utils.h"
#include "serialization/stl_containers.h"
#include "currency_core/currency_config.h"
#include "crypto/crypto.h"
#include "crypto/hash.h"
#include "common/int-util.h"
#include "randomx.h"

namespace currency
{
  // Like Monero, the RandomX key changes every 2048 blocks. Unlike Monero it doesn't come from a block hash: the PoW
  // hash here is computed from the height alone, also for blocks on other branches, so the key is derived from the
  // genesis hash and the epoch number. Datasets can be built ahead of time, which changes nothing for the work itself.
  static const uint64_t KUSARI_RX_EPOCH_BLOCKS = 2048;

  //------------------------------------------------------------------
  int ethash_height_to_epoch(uint64_t height)
  {
    return static_cast<int>(height / KUSARI_RX_EPOCH_BLOCKS);
  }
  //--------------------------------------------------------------
  crypto::hash ethash_epoch_to_seed(int epoch)
  {
    static const char domain[] = "Kusari RandomX key v1";
    std::string buf(domain, sizeof(domain) - 1);
    const crypto::hash& genesis = get_genesis_hash();
    buf.append(reinterpret_cast<const char*>(&genesis), sizeof(genesis));
    uint64_t e = SWAP64LE(static_cast<uint64_t>(epoch));
    buf.append(reinterpret_cast<const char*>(&e), sizeof(e));
    return crypto::cn_fast_hash(buf.data(), buf.size());
  }
  //--------------------------------------------------------------
  crypto::hash kusari_rx_seed(uint64_t height)
  {
    return ethash_epoch_to_seed(ethash_height_to_epoch(height));
  }

  namespace
  {
    // Light mode: a 256 MiB cache per key, shared by every thread. Three slots cover the current and previous epoch
    // plus one for a block far back on another branch.
    struct rx_slot
    {
      crypto::hash seed = null_hash;
      randomx_cache* cache = nullptr;
      uint64_t used = 0;
    };
    std::shared_mutex g_rx_lock;
    rx_slot g_rx_slots[3];
    uint64_t g_rx_clock = 0;

    randomx_flags rx_flags()
    {
      static const randomx_flags f = randomx_get_flags();
      return f;
    }

    // Called with g_rx_lock held exclusively.
    rx_slot& rx_slot_for(const crypto::hash& seed)
    {
      rx_slot* oldest = &g_rx_slots[0];
      for (auto& s : g_rx_slots)
      {
        if (s.cache && s.seed == seed)
        {
          s.used = ++g_rx_clock;
          return s;
        }
        if (s.used < oldest->used)
          oldest = &s;
      }
      if (!oldest->cache)
      {
        oldest->cache = randomx_alloc_cache(rx_flags());
        if (!oldest->cache)
          oldest->cache = randomx_alloc_cache(rx_flags() & ~RANDOMX_FLAG_JIT);
        if (!oldest->cache)
        {
          LOG_ERROR("fatal error: randomx_alloc_cache failed, throwing bad_alloc...");
          throw std::bad_alloc();
        }
      }
      randomx_init_cache(oldest->cache, &seed, sizeof(seed));
      oldest->seed = seed;
      oldest->used = ++g_rx_clock;
      return *oldest;
    }

    struct rx_thread_vm
    {
      randomx_vm* vm = nullptr;
      randomx_cache* cache = nullptr;
      crypto::hash seed = null_hash;
      ~rx_thread_vm() { if (vm) randomx_destroy_vm(vm); }
    };
  }
  //--------------------------------------------------------------
  crypto::hash get_block_longhash(uint64_t height, const crypto::hash& block_header_hash, uint64_t nonce)
  {
    const crypto::hash seed = kusari_rx_seed(height);
    thread_local rx_thread_vm t;

    // Input: the header hash (nonce zeroed) and then the nonce, the two values ProgPoWZ took.
    char input[sizeof(crypto::hash) + sizeof(uint64_t)];
    memcpy(input, &block_header_hash, sizeof(crypto::hash));
    uint64_t le_nonce = SWAP64LE(nonce);
    memcpy(input + sizeof(crypto::hash), &le_nonce, sizeof(le_nonce));

    for (;;)
    {
      {
        // Hashing reads the cache, so it holds the lock shared; a cache is only rebuilt with it held exclusively.
        std::shared_lock<std::shared_mutex> read(g_rx_lock);
        for (auto& s : g_rx_slots)
        {
          if (s.cache && s.seed == seed)
          {
            if (!t.vm)
            {
              t.vm = randomx_create_vm(rx_flags(), s.cache, nullptr);
              if (!t.vm)
                t.vm = randomx_create_vm(rx_flags() & ~RANDOMX_FLAG_JIT, s.cache, nullptr);
              if (!t.vm)
              {
                LOG_ERROR("fatal error: randomx_create_vm failed, throwing bad_alloc...");
                throw std::bad_alloc();
              }
            }
            else if (t.cache != s.cache || t.seed != seed)
            {
              randomx_vm_set_cache(t.vm, s.cache);
            }
            t.cache = s.cache;
            t.seed = seed;
            crypto::hash result = null_hash;
            randomx_calculate_hash(t.vm, input, sizeof(input), &result);
            return result;
          }
        }
      }
      std::unique_lock<std::shared_mutex> write(g_rx_lock);
      rx_slot_for(seed);
      // A slot another thread's VM pointed at may have been rebuilt for a different key: the check above sets the
      // cache again whenever the seed it last used isn't the one asked for.
      t.seed = null_hash;
    }
  }
  //--------------------------------------------------------------
  // Mining. Checking a block uses the 256 MiB cache above, which is all a node needs. Mining with it is about ten
  // times slower than with RandomX's full 2 GiB dataset, so the miner builds the dataset for the current key in the
  // background and switches to it when it is ready. Both give the same hash. KUSARI_RX_LIGHT=1 keeps the miner on
  // the cache, for machines without the memory.
  namespace
  {
    struct rx_mining_dataset
    {
      std::shared_mutex use;              // shared while hashing, exclusive while the dataset is rebuilt
      randomx_dataset* dataset = nullptr;
      crypto::hash seed = null_hash;      // the key the dataset holds, once ready
      std::atomic<bool> ready{false};
      std::atomic<bool> building{false};
      std::atomic<bool> unavailable{false};
    };
    rx_mining_dataset g_rx_ds;

    bool rx_light_only()
    {
      static const bool light = [] { const char* e = getenv("KUSARI_RX_LIGHT"); return e && *e && *e != '0'; }();
      return light;
    }

    void rx_build_dataset(crypto::hash seed)
    {
      const randomx_flags flags = rx_flags() | RANDOMX_FLAG_FULL_MEM;
      randomx_cache* cache = randomx_alloc_cache(rx_flags());
      if (!cache)
      {
        g_rx_ds.unavailable = true;
        g_rx_ds.building = false;
        return;
      }
      randomx_init_cache(cache, &seed, sizeof(seed));
      {
        std::unique_lock<std::shared_mutex> write(g_rx_ds.use);
        g_rx_ds.ready = false;
        if (!g_rx_ds.dataset)
          g_rx_ds.dataset = randomx_alloc_dataset(flags);
        if (!g_rx_ds.dataset)
        {
          LOG_PRINT_YELLOW("RandomX: no memory for the 2 GiB mining dataset, mining stays in the slower light mode", LOG_LEVEL_0);
          g_rx_ds.unavailable = true;
          g_rx_ds.building = false;
          randomx_release_cache(cache);
          return;
        }
        LOG_PRINT_L0("RandomX: building the mining dataset, mining in light mode until it is ready...");
        const unsigned long items = randomx_dataset_item_count();
        const unsigned long threads = std::max<unsigned long>(1, std::thread::hardware_concurrency());
        std::vector<std::thread> workers;
        for (unsigned long i = 0; i < threads; ++i)
        {
          const unsigned long from = items * i / threads, to = items * (i + 1) / threads;
          workers.emplace_back([=] { randomx_init_dataset(g_rx_ds.dataset, cache, from, to - from); });
        }
        for (auto& w : workers)
          w.join();
        g_rx_ds.seed = seed;
        g_rx_ds.ready = true;
      }
      randomx_release_cache(cache);
      g_rx_ds.building = false;
      LOG_PRINT_GREEN("RandomX: mining dataset ready", LOG_LEVEL_0);
    }

    struct rx_thread_fast_vm
    {
      randomx_vm* vm = nullptr;
      ~rx_thread_fast_vm() { if (vm) randomx_destroy_vm(vm); }
    };
  }
  //--------------------------------------------------------------
  crypto::hash get_block_longhash_mining(uint64_t height, const crypto::hash& block_header_hash, uint64_t nonce)
  {
    if (rx_light_only() || g_rx_ds.unavailable)
      return get_block_longhash(height, block_header_hash, nonce);

    const crypto::hash seed = kusari_rx_seed(height);
    {
      std::shared_lock<std::shared_mutex> read(g_rx_ds.use, std::try_to_lock);
      if (read.owns_lock() && g_rx_ds.ready && g_rx_ds.seed == seed)
      {
        thread_local rx_thread_fast_vm t;
        if (!t.vm)
          t.vm = randomx_create_vm(rx_flags() | RANDOMX_FLAG_FULL_MEM, nullptr, g_rx_ds.dataset);
        if (t.vm)
        {
          char input[sizeof(crypto::hash) + sizeof(uint64_t)];
          memcpy(input, &block_header_hash, sizeof(crypto::hash));
          uint64_t le_nonce = SWAP64LE(nonce);
          memcpy(input + sizeof(crypto::hash), &le_nonce, sizeof(le_nonce));
          crypto::hash result = null_hash;
          randomx_calculate_hash(t.vm, input, sizeof(input), &result);
          return result;
        }
      }
    }
    // No dataset for this key yet (first use, or a new 2048-block epoch): build it once, off the mining threads.
    bool expected = false;
    if (g_rx_ds.building.compare_exchange_strong(expected, true))
      std::thread(rx_build_dataset, seed).detach();
    return get_block_longhash(height, block_header_hash, nonce);
  }
  //---------------------------------------------------------------
  crypto::hash get_block_header_mining_hash(const block& b)
  {
    blobdata bd = get_block_hashing_blob(b);

    set_nonce_to_blockblob(bd, 0);
    return crypto::cn_fast_hash(bd.data(), bd.size());
  }
  //---------------------------------------------------------------
  void get_block_longhash(const block& b, crypto::hash& res)
  {
    // The header is hashed with its nonce zeroed and the nonce is passed next to it, as Zano did for ProgPoWZ.
    crypto::hash bl_hash = get_block_header_mining_hash(b);
    res = get_block_longhash(get_block_height(b), bl_hash, b.nonce);
  }
  //---------------------------------------------------------------
  crypto::hash get_block_longhash(const block& b)
  {
    crypto::hash p = null_hash;
    get_block_longhash(b, p);
    return p;
  }
}
