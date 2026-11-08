// mweb-bridge: Litecoin MWEB for Kusari Wallet. It runs a light client (from mwebd) that follows the Litecoin
// network, finds the account's MWEB coins and builds MWEB transactions. It talks one JSON line at a time on
// stdin/stdout: {"id":1,"m":"status","p":{}} -> {"id":1,"result":{...}} or {"id":1,"error":"..."}.
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/ltcmweb/ltcd/btcec/v2"
	"github.com/ltcmweb/ltcd/chaincfg/chainhash"
	"github.com/ltcmweb/ltcd/ltcutil"
	"github.com/ltcmweb/ltcd/ltcutil/mweb"
	"github.com/ltcmweb/ltcd/ltcutil/mweb/mw"
	"github.com/ltcmweb/ltcd/txscript"
	"github.com/ltcmweb/ltcd/wire"
	"github.com/ltcmweb/mwebd/proto"
	"golang.org/x/net/proxy"

	"kusari.local/mwebbridge/engine"
)

const version = "1"

var (
	out     = bufio.NewWriter(os.Stdout)
	outMtx  sync.Mutex
	server  *engine.Server
	scanner *engine.Scanner
	scanMtx sync.Mutex
	// Coins this wallet spent that the network hasn't confirmed yet, so they aren't offered again.
	spending = map[string]time.Time{}
)

type request struct {
	ID int             `json:"id"`
	M  string          `json:"m"`
	P  json.RawMessage `json:"p"`
}

func reply(id int, result any, err error) {
	outMtx.Lock()
	defer outMtx.Unlock()
	var line []byte
	if err != nil {
		line, _ = json.Marshal(map[string]any{"id": id, "error": err.Error()})
	} else {
		line, _ = json.Marshal(map[string]any{"id": id, "result": result})
	}
	out.Write(line)
	out.WriteByte('\n')
	out.Flush()
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "--version" {
		fmt.Println("mweb-bridge", version)
		return
	}
	in := bufio.NewReaderSize(os.Stdin, 1<<20)
	for {
		line, err := in.ReadBytes('\n')
		if len(bytes.TrimSpace(line)) > 0 {
			var r request
			if json.Unmarshal(line, &r) == nil {
				go func(r request) {
					defer func() {
						if p := recover(); p != nil {
							reply(r.ID, nil, fmt.Errorf("internal error: %v", p))
						}
					}()
					res, err := handle(r.M, r.P)
					reply(r.ID, res, err)
				}(r)
			}
		}
		if err != nil {
			// The app closed our input: it has quit or locked.
			if server != nil {
				server.Stop()
			}
			return
		}
	}
}

func hexBytes(s string, n int) ([]byte, error) {
	b, err := hex.DecodeString(s)
	if err != nil || (n > 0 && len(b) != n) {
		return nil, errors.New("bad key")
	}
	return b, nil
}

func secret(s string) (mw.SecretKey, error) {
	var k mw.SecretKey
	b, err := hexBytes(s, 32)
	if err != nil {
		return k, err
	}
	copy(k[:], b)
	return k, nil
}

func ready() error {
	if server == nil {
		return errors.New("MWEB is not started")
	}
	return nil
}

func handle(m string, raw json.RawMessage) (any, error) {
	switch m {
	case "version":
		return version, nil
	case "start":
		var p struct {
			DataDir string   `json:"dataDir"`
			Socks   string   `json:"socks"`
			Connect string   `json:"connect"` // an HTTP CONNECT proxy (tests and locked-down networks)
			Peers   []string `json:"peers"`
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, err
		}
		return nil, start(p.DataDir, p.Socks, p.Connect, p.Peers)
	case "status":
		if err := ready(); err != nil {
			return nil, err
		}
		st, err := server.Status(context.Background(), &proto.StatusRequest{})
		if err != nil {
			return nil, err
		}
		res := map[string]any{"headers": st.BlockHeaderHeight, "mwebHeaders": st.MwebHeaderHeight, "mwebUtxos": st.MwebUtxosHeight, "blockTime": st.BlockTime, "peers": server.Peers()}
		scanMtx.Lock()
		if scanner != nil {
			res["scanDone"], res["scanSize"], res["scanReady"] = scanner.Done, scanner.Size, scanner.Ready
		}
		scanMtx.Unlock()
		return res, nil
	case "addresses":
		var p struct {
			Scan, SpendPub string
			From, To       uint32
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, err
		}
		if err := ready(); err != nil {
			return nil, err
		}
		scan, err := hexBytes(p.Scan, 32)
		if err != nil {
			return nil, err
		}
		pub, err := hexBytes(p.SpendPub, 33)
		if err != nil {
			return nil, err
		}
		if p.To <= p.From || p.To-p.From > 1000 {
			return nil, errors.New("bad range")
		}
		resp, err := server.Addresses(context.Background(), &proto.AddressRequest{FromIndex: p.From, ToIndex: p.To, ScanSecret: scan, SpendPubkey: pub})
		if err != nil {
			return nil, err
		}
		return resp.Address, nil
	case "watch":
		var p struct{ Scan string }
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, err
		}
		if err := ready(); err != nil {
			return nil, err
		}
		k, err := secret(p.Scan)
		if err != nil {
			return nil, err
		}
		watch(k)
		return nil, nil
	case "coins":
		if err := ready(); err != nil {
			return nil, err
		}
		scanMtx.Lock()
		sc := scanner
		scanMtx.Unlock()
		if sc == nil {
			return nil, errors.New("not watching an account")
		}
		coins := server.Coins(sc)
		kept := coins[:0]
		scanMtx.Lock()
		for id, at := range spending {
			if time.Since(at) > 6*time.Hour {
				delete(spending, id)
			}
		}
		for _, c := range coins {
			if _, gone := spending[c.OutputID]; !gone {
				kept = append(kept, c)
			}
		}
		scanMtx.Unlock()
		return map[string]any{"ready": sc.Ready, "coins": kept}, nil
	case "send":
		return send(raw)
	case "pegin":
		return pegin(raw)
	}
	return nil, fmt.Errorf("unknown method %s", m)
}

func start(dataDir, socks, connect string, peers []string) error {
	if server != nil {
		return nil
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return err
	}
	args := &engine.ServerArgs{Chain: "mainnet", DataDir: dataDir, Peers: peers}
	switch {
	case socks != "":
		// Tor: peers are reached and seed names looked up through it, never directly.
		d, err := proxy.SOCKS5("tcp", socks, nil, proxy.Direct)
		if err != nil {
			return err
		}
		args.Dial = func(a net.Addr) (net.Conn, error) { return d.Dial("tcp", a.String()) }
		args.Resolve = func(host string) ([]net.IP, error) { return literalOr(host, func() ([]net.IP, error) { return torResolve(socks, host) }) }
	case connect != "":
		args.Dial = func(a net.Addr) (net.Conn, error) { return dialConnect(connect, a.String()) }
		args.Resolve = func(host string) ([]net.IP, error) { return literalOr(host, func() ([]net.IP, error) { return dohResolve(connect, host) }) }
	}
	s, err := engine.NewServer2(args)
	if err != nil {
		return err
	}
	server = s
	return nil
}

func watch(k mw.SecretKey) {
	scanMtx.Lock()
	defer scanMtx.Unlock()
	if scanner != nil {
		return
	}
	sc := engine.NewScanner(k)
	scanner = sc
	go func() {
		for {
			server.Pass(sc, nil)
			time.Sleep(10 * time.Second)
			scanMtx.Lock()
			still := scanner == sc
			scanMtx.Unlock()
			if !still {
				return
			}
		}
	}()
}

type coinRef struct {
	OutputID  string `json:"outputId"`
	AddrIndex uint32 `json:"addrIndex"`
}

type payment struct {
	Address string `json:"address"`
	Value   int64  `json:"value"`
}

func scriptFor(addr string) ([]byte, error) {
	a, err := ltcutil.DecodeAddress(addr, server.Params())
	if err != nil || !a.IsForNet(server.Params()) {
		return nil, errors.New("not a Litecoin address")
	}
	return txscript.PayToAddrScript(a)
}

// send spends MWEB coins: to MWEB addresses privately, or to ordinary addresses as peg-outs. The rest comes back
// to the account's change address. With dryRun nothing is signed or sent; the fee comes back.
func send(raw json.RawMessage) (any, error) {
	var p struct {
		Scan, Spend string
		Coins       []coinRef `json:"coins"`
		To          payment   `json:"to"`
		Max         bool      `json:"max"`
		Change      string    `json:"change"`
		FeePerKb    uint64    `json:"feePerKb"`
		DryRun      bool      `json:"dryRun"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, err
	}
	if err := ready(); err != nil {
		return nil, err
	}
	scan, err := hexBytes(p.Scan, 32)
	if err != nil {
		return nil, err
	}
	var spend []byte
	if !p.DryRun {
		if spend, err = hexBytes(p.Spend, 32); err != nil {
			return nil, err
		}
	}
	if len(p.Coins) == 0 {
		return nil, errors.New("No private LTC to send.")
	}
	if p.FeePerKb == 0 || p.FeePerKb > 10_000_000 {
		return nil, errors.New("bad fee rate")
	}
	toScript, err := scriptFor(p.To.Address)
	if err != nil {
		return nil, err
	}
	changeScript, err := scriptFor(p.Change)
	if err != nil || !txscript.IsMweb(changeScript) {
		return nil, errors.New("bad change address")
	}
	tx := wire.NewMsgTx(2)
	var total uint64
	sc := currentScanner()
	values := map[string]uint64{}
	for _, c := range server.Coins(sc) {
		values[c.OutputID] = c.Value
	}
	for _, c := range p.Coins {
		v, ok := values[c.OutputID]
		if !ok {
			return nil, errors.New("A private coin is no longer available. Wait for the balance to update and try again.")
		}
		id, err := hexBytes(c.OutputID, 32)
		if err != nil {
			return nil, err
		}
		var h chainhash.Hash
		copy(h[:], id)
		tx.AddTxIn(wire.NewTxIn(wire.NewOutPoint(&h, c.AddrIndex), nil, nil))
		total += v
	}
	feeRate := ltcutil.Amount(p.FeePerKb)
	withChange := []*wire.TxOut{wire.NewTxOut(0, toScript), wire.NewTxOut(0, changeScript)}
	fee := mweb.EstimateFee(withChange, feeRate, false)
	amount := uint64(p.To.Value)
	if p.Max {
		fee = mweb.EstimateFee(withChange[:1], feeRate, false)
		if total <= fee {
			return nil, errors.New("No private LTC left to send after the fee.")
		}
		amount = total - fee
	}
	if amount == 0 {
		return nil, errors.New("The amount must be more than zero.")
	}
	if amount+fee > total {
		return nil, fmt.Errorf("Not enough private LTC. Up to %s can be sent.", ltcutil.Amount(int64(total)-int64(fee)).String())
	}
	tx.AddTxOut(wire.NewTxOut(int64(amount), toScript))
	change := total - amount - fee
	if !p.Max && change > 0 {
		tx.AddTxOut(wire.NewTxOut(int64(change), changeScript))
	} else if !p.Max {
		fee = total - amount
	}
	result := map[string]any{"amount": amount, "fee": fee, "pegout": !txscript.IsMweb(toScript)}
	if p.DryRun {
		return result, nil
	}
	var buf bytes.Buffer
	if err = tx.Serialize(&buf); err != nil {
		return nil, err
	}
	created, err := server.Create(context.Background(), &proto.CreateRequest{RawTx: buf.Bytes(), ScanSecret: scan, SpendSecret: spend, FeeRatePerKb: p.FeePerKb})
	if err != nil {
		return nil, err
	}
	var built wire.MsgTx
	if err = built.Deserialize(bytes.NewReader(created.RawTx)); err != nil {
		return nil, err
	}
	if len(built.TxOut) > 0 {
		// A peg-in here would mean the MWEB coins didn't cover the payment: never pay it from elsewhere.
		return nil, errors.New("The private balance changed while preparing. Try again.")
	}
	sent, err := server.Broadcast(context.Background(), &proto.BroadcastRequest{RawTx: created.RawTx})
	if err != nil {
		return nil, err
	}
	scanMtx.Lock()
	for _, c := range p.Coins {
		spending[c.OutputID] = time.Now()
	}
	scanMtx.Unlock()
	result["txid"] = sent.Txid
	return result, nil
}

type transparentIn struct {
	Txid   string `json:"txid"`
	Vout   uint32 `json:"vout"`
	Value  int64  `json:"value"`
	Script string `json:"script"` // the P2WPKH script it pays to
	Key    string `json:"key"`    // its private key; omitted for a dry run
}

// pegin moves ordinary (public) LTC into the account's MWEB address. All the given inputs go in; nothing comes back
// as public change.
func pegin(raw json.RawMessage) (any, error) {
	var p struct {
		To       string          `json:"to"`
		Inputs   []transparentIn `json:"inputs"`
		FeePerKb uint64          `json:"feePerKb"`
		DryRun   bool            `json:"dryRun"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, err
	}
	if err := ready(); err != nil {
		return nil, err
	}
	if len(p.Inputs) == 0 {
		return nil, errors.New("No public LTC to make private.")
	}
	if p.FeePerKb == 0 || p.FeePerKb > 10_000_000 {
		return nil, errors.New("bad fee rate")
	}
	toScript, err := scriptFor(p.To)
	if err != nil || !txscript.IsMweb(toScript) {
		return nil, errors.New("bad MWEB address")
	}
	tx := wire.NewMsgTx(2)
	prev := map[wire.OutPoint]*wire.TxOut{}
	var total int64
	for _, in := range p.Inputs {
		h, err := chainhash.NewHashFromStr(in.Txid)
		if err != nil {
			return nil, err
		}
		script, err := hexBytes(in.Script, 22)
		if err != nil || script[0] != 0 || script[1] != 20 {
			return nil, errors.New("only native SegWit coins can be made private")
		}
		op := wire.NewOutPoint(h, in.Vout)
		tx.AddTxIn(wire.NewTxIn(op, nil, nil))
		prev[*op] = wire.NewTxOut(in.Value, script)
		total += in.Value
	}
	mwebOut := wire.NewTxOut(0, toScript)
	mwebFee := int64(mweb.EstimateFee([]*wire.TxOut{mwebOut}, ltcutil.Amount(p.FeePerKb), false))
	// The public part: version, counts and lock time, each P2WPKH input, the peg-in output, plus the HogEx input
	// the miner adds for the peg-in.
	vbytes := int64(11 + 68*len(p.Inputs) + 43 + 41)
	txFee := (vbytes*int64(p.FeePerKb) + 999) / 1000
	value := total - txFee - mwebFee
	if value <= 0 {
		return nil, errors.New("No public LTC left to make private after the fee.")
	}
	mwebOut.Value = value
	tx.AddTxOut(mwebOut)
	result := map[string]any{"amount": value, "fee": txFee + mwebFee}
	if p.DryRun {
		return result, nil
	}
	var buf bytes.Buffer
	if err = tx.Serialize(&buf); err != nil {
		return nil, err
	}
	created, err := server.Create(context.Background(), &proto.CreateRequest{RawTx: buf.Bytes(), FeeRatePerKb: p.FeePerKb})
	if err != nil {
		return nil, err
	}
	var built wire.MsgTx
	if err = built.Deserialize(bytes.NewReader(created.RawTx)); err != nil {
		return nil, err
	}
	if len(built.TxOut) != 1 || built.TxOut[0].Value != total-txFee {
		return nil, errors.New("The private transaction came out different from what was planned, so it was not sent.")
	}
	fetcher := txscript.NewMultiPrevOutFetcher(prev)
	hashes := txscript.NewTxSigHashes(&built, fetcher)
	for i, txIn := range built.TxIn {
		var key string
		for _, in := range p.Inputs {
			if h, _ := chainhash.NewHashFromStr(in.Txid); h != nil && *h == txIn.PreviousOutPoint.Hash && in.Vout == txIn.PreviousOutPoint.Index {
				key = in.Key
			}
		}
		k, err := hexBytes(key, 32)
		if err != nil {
			return nil, err
		}
		priv, _ := btcec.PrivKeyFromBytes(k)
		pt := prev[txIn.PreviousOutPoint]
		if !bytes.Equal(pt.PkScript[2:], ltcutil.Hash160(priv.PubKey().SerializeCompressed())) {
			return nil, errors.New("a key doesn't match its coin")
		}
		w, err := txscript.WitnessSignature(&built, hashes, i, pt.Value, pt.PkScript, txscript.SigHashAll, priv, true)
		if err != nil {
			return nil, err
		}
		built.TxIn[i].Witness = w
	}
	buf.Reset()
	if err = built.Serialize(&buf); err != nil {
		return nil, err
	}
	sent, err := server.Broadcast(context.Background(), &proto.BroadcastRequest{RawTx: buf.Bytes()})
	if err != nil {
		return nil, err
	}
	result["txid"] = sent.Txid
	return result, nil
}

func currentScanner() *engine.Scanner {
	scanMtx.Lock()
	defer scanMtx.Unlock()
	return scanner
}

// literalOr returns an address written as numbers without looking anything up.
func literalOr(host string, lookup func() ([]net.IP, error)) ([]net.IP, error) {
	if ip := net.ParseIP(host); ip != nil {
		return []net.IP{ip}, nil
	}
	return lookup()
}

// torResolve asks Tor to look a name up (its SOCKS RESOLVE extension), so DNS never leaves Tor.
func torResolve(socks, host string) ([]net.IP, error) {
	c, err := net.DialTimeout("tcp", socks, 30*time.Second)
	if err != nil {
		return nil, err
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(60 * time.Second))
	if _, err = c.Write([]byte{5, 1, 0}); err != nil {
		return nil, err
	}
	hello := make([]byte, 2)
	if _, err = io.ReadFull(c, hello); err != nil || hello[1] != 0 {
		return nil, errors.New("Tor refused the lookup")
	}
	if len(host) > 255 {
		return nil, errors.New("name too long")
	}
	msg := append([]byte{5, 0xF0, 0, 3, byte(len(host))}, host...)
	msg = binary.BigEndian.AppendUint16(msg, 0)
	if _, err = c.Write(msg); err != nil {
		return nil, err
	}
	head := make([]byte, 4)
	if _, err = io.ReadFull(c, head); err != nil || head[1] != 0 {
		return nil, fmt.Errorf("Tor could not resolve %s", host)
	}
	size := 4
	if head[3] == 4 {
		size = 16
	}
	ip := make([]byte, size+2)
	if _, err = io.ReadFull(c, ip); err != nil {
		return nil, err
	}
	return []net.IP{net.IP(ip[:size])}, nil
}

// dialConnect reaches a peer through an HTTP proxy's CONNECT.
func dialConnect(proxyURL, addr string) (net.Conn, error) {
	u, err := url.Parse(proxyURL)
	if err != nil {
		return nil, err
	}
	c, err := net.DialTimeout("tcp", u.Host, 30*time.Second)
	if err != nil {
		return nil, err
	}
	fmt.Fprintf(c, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n", addr, addr)
	r := bufio.NewReader(c)
	resp, err := http.ReadResponse(r, &http.Request{Method: "CONNECT"})
	if err != nil || resp.StatusCode != 200 {
		c.Close()
		return nil, fmt.Errorf("proxy refused %s", addr)
	}
	if r.Buffered() > 0 {
		c.Close()
		return nil, errors.New("proxy sent data early")
	}
	return c, nil
}

// dohResolve looks names up over HTTPS through the same proxy (for networks without DNS).
func dohResolve(proxyURL, host string) ([]net.IP, error) {
	u, _ := url.Parse(proxyURL)
	client := &http.Client{Timeout: 30 * time.Second, Transport: &http.Transport{Proxy: http.ProxyURL(u)}}
	resp, err := client.Get("https://dns.google/resolve?type=A&name=" + url.QueryEscape(host))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var body struct{ Answer []struct{ Type int; Data string } }
	if err = json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, err
	}
	var ips []net.IP
	for _, a := range body.Answer {
		if ip := net.ParseIP(strings.TrimSpace(a.Data)); a.Type == 1 && ip != nil {
			ips = append(ips, ip)
		}
	}
	if len(ips) == 0 {
		return nil, fmt.Errorf("no address for %s", host)
	}
	return ips, nil
}
