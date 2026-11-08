package engine

import (
	"bytes"
	"encoding/hex"
	"sync"

	"github.com/ltcmweb/ltcd/chaincfg"
	"github.com/ltcmweb/ltcd/ltcutil/mweb/mw"
	"github.com/ltcmweb/ltcd/wire"
	"github.com/ltcmweb/mwebd/proto"
	"github.com/ltcsuite/ltcwallet/walletdb"
)

// Coin is one MWEB output this account owns.
type Coin struct {
	OutputID  string `json:"outputId"`
	Value     uint64 `json:"value"`
	Address   string `json:"address"`
	Height    int32  `json:"height"`
	BlockTime uint32 `json:"blockTime"`
}

// Scanner keeps an account's coins up to date. The UTXO set only ever grows at the end and loses spent leaves, so
// every leaf is checked once: later passes look only at new leaves and drop the ones that left the set.
type Scanner struct {
	mtx     sync.Mutex
	scan    mw.SecretKey
	checked []byte // one bit per leaf already looked at
	mine    map[uint64]Coin
	Done    uint64 // leaves looked at in the last pass
	Size    uint64 // leaves in the set
	Ready   bool   // a whole pass has finished
}

func NewScanner(scan mw.SecretKey) *Scanner { return &Scanner{scan: scan, mine: map[uint64]Coin{}} }

func (sc *Scanner) seen(leaf uint64) bool {
	i := leaf / 8
	return i < uint64(len(sc.checked)) && sc.checked[i]&(1<<(leaf%8)) != 0
}

func (sc *Scanner) mark(leaf uint64) {
	i := leaf / 8
	for uint64(len(sc.checked)) <= i {
		sc.checked = append(sc.checked, 0)
	}
	sc.checked[i] |= 1 << (leaf % 8)
}

// Pass looks at every leaf not seen before and forgets coins that are no longer unspent.
func (s *Server) Pass(sc *Scanner, progress func(done, size uint64)) error {
	lfs, err := s.cs.MwebCoinDB.GetLeafset()
	if err != nil {
		return err
	}
	sc.mtx.Lock()
	sc.Size = lfs.Size
	sc.mtx.Unlock()
	batch := make([]uint64, 0, 1000)
	flush := func() error {
		if len(batch) == 0 {
			return nil
		}
		utxos, err := s.cs.MwebCoinDB.FetchLeaves(batch)
		if err != nil {
			return err
		}
		found := s.filterUtxos(&sc.scan, utxos)
		byID := map[string]*wire.MwebNetUtxo{}
		for _, u := range utxos {
			byID[hex.EncodeToString(u.OutputId[:])] = u
		}
		sc.mtx.Lock()
		for _, f := range found {
			if u := byID[f.OutputId]; u != nil {
				sc.mine[u.LeafIndex] = Coin{f.OutputId, f.Value, f.Address, f.Height, f.BlockTime}
			}
		}
		for _, leaf := range batch {
			sc.mark(leaf)
		}
		sc.mtx.Unlock()
		batch = batch[:0]
		return nil
	}
	for leaf := uint64(0); leaf < lfs.Size; leaf++ {
		if lfs.Contains(leaf) && !sc.seen(leaf) {
			batch = append(batch, leaf)
			if len(batch) == cap(batch) {
				if err := flush(); err != nil {
					return err
				}
				if progress != nil {
					progress(leaf, lfs.Size)
				}
			}
		}
	}
	if err := flush(); err != nil {
		return err
	}
	sc.mtx.Lock()
	for leaf := range sc.mine {
		if !lfs.Contains(leaf) {
			delete(sc.mine, leaf)
		}
	}
	sc.Done = lfs.Size
	sc.Ready = true
	sc.mtx.Unlock()
	return nil
}

// Coins is what the account holds now: confirmed coins, plus coins seen in the mempool (height 0).
func (s *Server) Coins(sc *Scanner) []Coin {
	sc.mtx.Lock()
	out := make([]Coin, 0, len(sc.mine))
	have := map[string]bool{}
	for _, c := range sc.mine {
		out = append(out, c)
		have[c.OutputID] = true
	}
	sc.mtx.Unlock()
	var pending []*wire.MwebNetUtxo
	walletdb.View(s.db, func(tx walletdb.ReadTx) error {
		bucket := tx.ReadBucket([]byte("mweb-mempool"))
		if bucket == nil {
			return nil
		}
		return bucket.ForEach(func(k, v []byte) error {
			output := &wire.MwebOutput{}
			if output.Deserialize(bytes.NewReader(v)) != nil {
				return nil
			}
			pending = append(pending, &wire.MwebNetUtxo{Output: output, OutputId: output.Hash()})
			return nil
		})
	})
	for _, f := range s.filterUtxos(&sc.scan, pending) {
		if !have[f.OutputId] {
			out = append(out, Coin{f.OutputId, f.Value, f.Address, 0, 0})
		}
	}
	return out
}

// AddressAt is the account's MWEB address at an index.
func (s *Server) AddressAt(scan, spendPub []byte, index uint32) (string, error) {
	resp, err := s.Addresses(nil, &proto.AddressRequest{FromIndex: index, ToIndex: index + 1, ScanSecret: scan, SpendPubkey: spendPub})
	if err != nil || len(resp.Address) == 0 {
		return "", err
	}
	return resp.Address[0], nil
}

// Params are the chain's parameters, for decoding addresses.
func (s *Server) Params() *chaincfg.Params { return &s.cp }

// Peers is how many Litecoin nodes the light client is connected to.
func (s *Server) Peers() int32 { return s.cs.ConnectedCount() }
