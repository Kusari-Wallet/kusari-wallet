// Unit test for dandelion.h. Build and run:
//   g++ -std=c++17 -O2 -I native/kusari-zano/dandelion native/kusari-zano/dandelion/test_dandelion.cpp -o /tmp/td && /tmp/td
#include "dandelion.h"

#include <cstdio>
#include <cstdlib>
#include <random>

using router = currency::dandelion_router<int>;
static int failures = 0;
#define CHECK(c) do { if (!(c)) { std::printf("FAIL %s:%d %s\n", __FILE__, __LINE__, #c); ++failures; } } while (0)

static std::mt19937_64 gen(12345);
static uint64_t rng() { return gen(); }

static currency::dandelion_config cfg(unsigned fluff_percent)
{
  currency::dandelion_config c;
  c.fluff_percent = fluff_percent;
  return c;
}

int main()
{
  const std::vector<int> peers = {11, 12, 13, 14};
  const int self = 0;

  // A stem node sends each source to one of its 2 stems, the same one all epoch.
  {
    router r(rng, cfg(0));
    auto first = r.route(self, 1000, peers);
    CHECK(!first.fluff);
    CHECK(r.stems().size() == 2);
    CHECK(first.to == r.stems()[0] || first.to == r.stems()[1]);
    for (int i = 0; i < 50; ++i)
      CHECK(r.route(self, 1000 + i * 1000, peers).to == first.to);
    // Other sources are spread over the stems but each keeps its own.
    std::set<int> used;
    for (int source = 100; source < 140; ++source)
    {
      auto d = r.route(source, 2000, peers);
      CHECK(!d.fluff);
      CHECK(r.route(source, 3000, peers).to == d.to);
      used.insert(d.to);
    }
    CHECK(used.size() == 2);
  }

  // Never back to where it came from.
  {
    router r(rng, cfg(0));
    r.route(self, 0, peers);
    for (int s : r.stems())
    {
      auto d = r.route(s, 10, peers);
      CHECK(!d.fluff && d.to != s);
    }
    router one(rng, cfg(0));
    auto d = one.route(self, 0, {11});
    CHECK(!d.fluff && d.to == 11);
    CHECK(one.route(11, 1, {11}).fluff); // its only stem is the source: broadcast instead
  }

  // A fluff epoch, or nobody to stem to, means broadcast.
  {
    router r(rng, cfg(100));
    CHECK(r.route(self, 0, peers).fluff);
    router alone(rng, cfg(0));
    CHECK(alone.route(self, 0, {}).fluff);
  }

  // Epochs: new stems after about 10 minutes, or as soon as a stem disconnects.
  {
    router r(rng, cfg(0));
    r.route(self, 0, peers);
    auto stems = r.stems();
    r.route(self, 9 * 60 * 1000, peers);
    CHECK(r.stems() == stems);
    std::vector<int> fewer;
    for (int p : peers)
      if (p != stems[0])
        fewer.push_back(p);
    auto d = r.route(self, 9 * 60 * 1000 + 1, fewer);
    CHECK(!d.fluff && d.to != stems[0]);
    for (int s : r.stems())
      CHECK(s != stems[0]);
    // An epoch with one peer takes a second stem when one connects.
    router grow(rng, cfg(0));
    grow.route(self, 0, {11});
    CHECK(grow.stems().size() == 1);
    grow.route(self, 1, {11, 12});
    CHECK(grow.stems().size() == 2);
  }

  // Embargo: broadcast by this node only if nobody else did in time.
  {
    router r(rng);
    router::tx_entry a{"a", "blob-a"}, b{"b", "blob-b"};
    r.embargo(a, 0);
    r.embargo(b, 0);
    CHECK(r.due(0).embargo_expired.empty());
    r.seen_fluff("b");
    auto w = r.due(10 * 39 * 1000);
    CHECK(w.embargo_expired.size() == 1 && w.embargo_expired[0].id == "a" && w.embargo_expired[0].blob == "blob-a");
    CHECK(r.embargoed() == 0);
  }

  // Fluff queue: once per transaction, after the delay, and it ends the embargo.
  {
    router r(rng);
    router::tx_entry a{"a", "blob-a"};
    r.embargo(a, 0);
    r.fluff(a, 0);
    r.fluff(a, 0);
    CHECK(r.embargoed() == 0 && r.queued() == 1);
    r.embargo(a, 0); // already on its way out: no new embargo
    CHECK(r.embargoed() == 0);
    auto w = r.due(10 * 5 * 1000);
    CHECK(w.fluff_now.size() == 1 && w.fluff_now[0].id == "a");
    CHECK(r.due(10 * 5 * 1000).fluff_now.empty());
    r.fluff(a, 0); // once sent it can be queued again (a later rebroadcast)
    CHECK(r.queued() == 1);
  }

  // The numbers: about 20% of epochs fluff, delays average 39 s and 5 s.
  {
    router r(rng);
    int fluffs = 0;
    const int epochs = 20000;
    uint64_t t = 0;
    for (int i = 0; i < epochs; ++i)
    {
      t += 11 * 60 * 1000;
      fluffs += r.route(self, t, peers).fluff ? 1 : 0;
    }
    double share = double(fluffs) / epochs;
    std::printf("fluff epochs: %.3f\n", share);
    CHECK(share > 0.18 && share < 0.22);

    router e(rng);
    double sum = 0, fsum = 0;
    const int n = 20000;
    for (int i = 0; i < n; ++i)
    {
      e.embargo(router::tx_entry{std::to_string(i), ""}, 0);
      e.fluff(router::tx_entry{"f" + std::to_string(i), ""}, 0);
    }
    // Read the deadlines back through due(): step time and count what comes due.
    uint64_t prev = 0;
    for (uint64_t ms = 0; ms <= 10 * 39 * 1000; ms += 100)
    {
      auto w = e.due(ms);
      sum += double(w.embargo_expired.size()) * (ms + prev) / 2.0;
      fsum += double(w.fluff_now.size()) * (ms + prev) / 2.0;
      prev = ms;
    }
    std::printf("embargo mean: %.0f ms, fluff delay mean: %.0f ms\n", sum / n, fsum / n);
    CHECK(sum / n > 36000 && sum / n < 42000);
    CHECK(fsum / n > 4500 && fsum / n < 5500);
  }

  std::printf(failures ? "dandelion test FAILED (%d)\n" : "dandelion test ok\n", failures);
  return failures ? 1 : 0;
}
