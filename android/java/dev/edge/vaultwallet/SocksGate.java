package dev.edge.vaultwallet;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Collections;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * A local SOCKS5 gateway between one engine (Zano, Kusari, Zcash, Pirate Chain...) and Tor, as socks-gate.ts on the
 * desktop. The engine connects without a login; the gateway logs in to Tor with a name of its own, which renew()
 * changes, so Tor puts the engine's next connection (a send) on a fresh circuit. Open connections close on renew.
 * Nothing goes anywhere but to Tor's port on this device.
 */
final class SocksGate {
    private volatile int torPort;
    private final ServerSocket server;
    private final Set<Socket> open = Collections.newSetFromMap(new ConcurrentHashMap<Socket, Boolean>());
    private volatile String login = fresh();

    SocksGate(int torPort) throws IOException {
        this.torPort = torPort;
        this.server = new ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"));
        Thread t = new Thread(new Runnable() { @Override public void run() { acceptLoop(); } }, "socks-gate");
        t.setDaemon(true);
        t.start();
    }

    int port() { return server.getLocalPort(); }

    /** Tor came back on another port: the engine keeps its own, new connections go to the new one. */
    void setTorPort(int p) { if (p != torPort) { torPort = p; renew(); } }

    void renew() {
        login = fresh();
        for (Socket s : open) closeQuietly(s);
        open.clear();
    }

    private static String fresh() {
        byte[] b = new byte[12];
        new SecureRandom().nextBytes(b);
        StringBuilder sb = new StringBuilder();
        for (byte x : b) sb.append(String.format("%02x", x));
        return sb.toString();
    }

    private void acceptLoop() {
        while (!server.isClosed()) {
            try {
                final Socket client = server.accept();
                Thread t = new Thread(new Runnable() { @Override public void run() { serve(client); } }, "socks-gate-conn");
                t.setDaemon(true);
                t.start();
            } catch (IOException e) {
                if (server.isClosed()) return;
            }
        }
    }

    private static void readFully(InputStream in, byte[] b, int n) throws IOException {
        int at = 0;
        while (at < n) {
            int got = in.read(b, at, n - at);
            if (got < 0) throw new IOException("closed");
            at += got;
        }
    }

    private void serve(final Socket client) {
        open.add(client);
        Socket tor = null;
        try {
            client.setSoTimeout(60_000);
            InputStream cin = client.getInputStream();
            OutputStream cout = client.getOutputStream();
            byte[] head = new byte[2];
            readFully(cin, head, 2);
            if (head[0] != 5) throw new IOException("not socks5");
            byte[] methods = new byte[head[1] & 0xff];
            readFully(cin, methods, methods.length);
            boolean plain = false;
            for (byte m : methods) if (m == 0) plain = true;
            if (!plain) { cout.write(new byte[] {5, (byte) 0xff}); throw new IOException("no method"); }
            cout.write(new byte[] {5, 0});
            byte[] req = new byte[4];
            readFully(cin, req, 4);
            if (req[0] != 5 || req[1] != 1) throw new IOException("not connect");
            int len;
            byte[] first = new byte[0];
            if (req[3] == 1) len = 4;
            else if (req[3] == 4) len = 16;
            else if (req[3] == 3) { first = new byte[1]; readFully(cin, first, 1); len = first[0] & 0xff; }
            else throw new IOException("bad address");
            byte[] addr = new byte[len + 2];
            readFully(cin, addr, addr.length);
            byte[] request = new byte[4 + first.length + addr.length];
            System.arraycopy(req, 0, request, 0, 4);
            System.arraycopy(first, 0, request, 4, first.length);
            System.arraycopy(addr, 0, request, 4 + first.length, addr.length);

            tor = new Socket();
            open.add(tor);
            tor.connect(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), torPort), 30_000);
            tor.setSoTimeout(120_000);
            InputStream tin = tor.getInputStream();
            OutputStream tout = tor.getOutputStream();
            byte[] user = login.getBytes(StandardCharsets.US_ASCII);
            tout.write(new byte[] {5, 1, 2});
            byte[] r = new byte[2];
            readFully(tin, r, 2);
            if (r[0] != 5 || r[1] != 2) throw new IOException("tor refused the login method");
            byte[] auth = new byte[3 + user.length * 2];
            auth[0] = 1; auth[1] = (byte) user.length;
            System.arraycopy(user, 0, auth, 2, user.length);
            auth[2 + user.length] = (byte) user.length;
            System.arraycopy(user, 0, auth, 3 + user.length, user.length);
            tout.write(auth);
            readFully(tin, r, 2);
            if (r[1] != 0) throw new IOException("tor refused the login");
            tout.write(request);
            byte[] rep = new byte[4];
            readFully(tin, rep, 4);
            int rlen;
            byte[] rfirst = new byte[0];
            if (rep[3] == 1) rlen = 4;
            else if (rep[3] == 4) rlen = 16;
            else if (rep[3] == 3) { rfirst = new byte[1]; readFully(tin, rfirst, 1); rlen = rfirst[0] & 0xff; }
            else throw new IOException("bad reply");
            byte[] rest = new byte[rlen + 2];
            readFully(tin, rest, rest.length);
            cout.write(rep);
            cout.write(rfirst);
            cout.write(rest);
            if (rep[1] != 0) throw new IOException("tor could not connect");
            client.setSoTimeout(0);
            tor.setSoTimeout(0);
            final Socket t = tor;
            Thread up = new Thread(new Runnable() { @Override public void run() { pump(client, t); } }, "socks-gate-up");
            up.setDaemon(true);
            up.start();
            pump(t, client);
        } catch (IOException e) {
            // Closed or refused: the engine sees a failed connection and tries again.
        } finally {
            closeQuietly(client);
            if (tor != null) closeQuietly(tor);
            open.remove(client);
            if (tor != null) open.remove(tor);
        }
    }

    private static void pump(Socket from, Socket to) {
        byte[] buf = new byte[16384];
        try {
            InputStream in = from.getInputStream();
            OutputStream out = to.getOutputStream();
            for (int n; (n = in.read(buf)) >= 0; ) out.write(buf, 0, n);
        } catch (IOException ignored) {
        } finally {
            closeQuietly(from);
            closeQuietly(to);
        }
    }

    private static void closeQuietly(Socket s) {
        try { s.close(); } catch (IOException ignored) { }
    }
}
