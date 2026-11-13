package dev.edge.vaultwallet;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Plain TCP for the Dash and Bitcoin peer-to-peer networks, which the WebView can't open itself. Only their ports
 * are allowed, Bitcoin's only through Tor. With a SOCKS port set, every connection goes through Tor on a route of
 * its own, and never directly.
 */
final class TcpBridge {
    interface Listener {
        void onOpen(int id);
        void onData(int id, byte[] data, int length);
        void onClose(int id, String error);
    }

    static final int DASH_PORT = 9999;
    static final int BTC_PORT = 8333;
    private static final int MAX_OPEN = 8;

    private final Listener listener;
    private final Map<Integer, Socket> open = new ConcurrentHashMap<>();
    private final ExecutorService pool = Executors.newCachedThreadPool();
    private final SecureRandom random = new SecureRandom();
    private volatile int socksPort = 0;
    private final int allowedPort;

    TcpBridge(Listener listener) { this(listener, DASH_PORT); }

    /** A different port is for tests only. */
    TcpBridge(Listener listener, int allowedPort) {
        this.listener = listener;
        this.allowedPort = allowedPort;
    }

    void setSocksPort(int port) { socksPort = port; }

    boolean open(final int id, final String host, final int port) {
        if ((port != allowedPort && !(port == BTC_PORT && socksPort > 0)) || host == null || host.isEmpty() || host.length() > 255 || open.size() >= MAX_OPEN || open.containsKey(id)) return false;
        pool.execute(new Runnable() { @Override public void run() { connect(id, host, port); } });
        return true;
    }

    private void connect(int id, String host, int port) {
        Socket s = null;
        try {
            int socks = socksPort;
            s = socks > 0 ? viaSocks(socks, host, port) : direct(host, port);
            s.setTcpNoDelay(true);
            s.setSoTimeout(0);
            open.put(id, s);
            listener.onOpen(id);
            InputStream in = s.getInputStream();
            byte[] buf = new byte[64 * 1024];
            for (int n; (n = in.read(buf)) > 0; ) listener.onData(id, buf, n);
            close(id, "");
        } catch (IOException | RuntimeException e) {
            if (s != null) try { s.close(); } catch (IOException ignored) { }
            open.remove(id);
            listener.onClose(id, "Could not connect to the Dash node.");
        }
    }

    private static Socket direct(String host, int port) throws IOException {
        Socket s = new Socket();
        s.connect(new InetSocketAddress(host, port), 30_000);
        return s;
    }

    /** SOCKS5 with the name unresolved, and a random login so Tor gives this connection its own route. */
    private Socket viaSocks(int socks, String host, int port) throws IOException {
        Socket raw = new Socket();
        raw.connect(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), socks), 30_000);
        try {
            raw.setSoTimeout(60_000);
            InputStream si = raw.getInputStream();
            OutputStream so = raw.getOutputStream();
            so.write(new byte[] { 5, 1, 2 });
            so.flush();
            if (si.read() != 5 || si.read() != 2) throw new IOException("socks hello");
            byte[] user = Long.toHexString(random.nextLong()).getBytes(StandardCharsets.US_ASCII);
            ByteArrayOutputStream login = new ByteArrayOutputStream();
            login.write(new byte[] { 1, (byte) user.length });
            login.write(user);
            login.write(new byte[] { 1, 'x' });
            so.write(login.toByteArray());
            so.flush();
            if (si.read() != 1 || si.read() != 0) throw new IOException("socks login");
            byte[] name = host.getBytes(StandardCharsets.US_ASCII);
            ByteArrayOutputStream req = new ByteArrayOutputStream();
            req.write(new byte[] { 5, 1, 0, 3, (byte) name.length });
            req.write(name);
            req.write((port >> 8) & 255);
            req.write(port & 255);
            so.write(req.toByteArray());
            so.flush();
            byte[] reply = read(si, 4);
            if (reply[0] != 5 || reply[1] != 0) throw new IOException("socks refused");
            int skip = reply[3] == 1 ? 6 : reply[3] == 4 ? 18 : reply[3] == 3 ? si.read() + 2 : -1;
            if (skip < 0) throw new IOException("socks reply");
            read(si, skip);
            return raw;
        } catch (IOException e) {
            raw.close();
            throw e;
        }
    }

    private static byte[] read(InputStream in, int n) throws IOException {
        byte[] b = new byte[n];
        for (int at = 0; at < n; ) {
            int r = in.read(b, at, n - at);
            if (r < 0) throw new IOException("closed");
            at += r;
        }
        return b;
    }

    boolean write(int id, byte[] data) {
        Socket s = open.get(id);
        if (s == null) return false;
        try {
            OutputStream o = s.getOutputStream();
            synchronized (s) { o.write(data); o.flush(); }
            return true;
        } catch (IOException e) {
            close(id, "The Dash node closed the connection.");
            return false;
        }
    }

    void close(int id, String error) {
        Socket s = open.remove(id);
        if (s == null) return;
        try { s.close(); } catch (IOException ignored) { }
        listener.onClose(id, error);
    }

    void closeAll() {
        for (Integer id : open.keySet()) close(id, "");
    }
}
