package dev.edge.vaultwallet;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * Forwards wallet requests from the WebView to one fixed outside server per local port.
 * Browsers block these requests otherwise, because Monero nodes send no CORS headers.
 * Listens on loopback only, strips browser headers, and answers only the app's own origin.
 */
final class LocalProxy {
    private static final int MAX_BODY = 64 * 1024 * 1024;
    private static final int MAX_HEADER = 64 * 1024;
    /** Not a header that's sent: a route name, for requests that must each leave on a Tor route of their own (CoinJoin). */
    static final String ROUTE = "\u0000route";

    private final String allowedOrigin;
    private final Map<String, Integer> ports = new ConcurrentHashMap<>();
    private final ExecutorService pool = Executors.newCachedThreadPool();
    private volatile int socksPort = 0;

    /** With a port set, everything goes through that SOCKS proxy and nothing else. 0 means direct. */
    void setSocksPort(int port) { socksPort = port; }

    private volatile int routeGeneration = 0;

    /** Connections from here on leave on new Tor routes. */
    void newRoutes() { routeGeneration++; }

    LocalProxy(String allowedOrigin) {
        this.allowedOrigin = allowedOrigin;
    }

    /** Returns the local port for an upstream such as http://node.example:18081, or 0 if it's refused. */
    synchronized int portFor(String upstream) {
        Integer known = ports.get(upstream);
        if (known != null) return known;
        try {
            URL url = new URL(upstream);
            String protocol = url.getProtocol();
            if (!("http".equals(protocol) || "https".equals(protocol)) || !url.getPath().isEmpty() || url.getQuery() != null) return 0;
            final ServerSocket server = new ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"));
            final String target = upstream;
            pool.execute(new Runnable() { @Override public void run() { accept(server, target); } });
            ports.put(upstream, server.getLocalPort());
            return server.getLocalPort();
        } catch (IOException e) {
            return 0;
        }
    }

    private void accept(ServerSocket server, String upstream) {
        while (true) {
            try {
                final Socket client = server.accept();
                pool.execute(new Runnable() { @Override public void run() { serve(client, upstream); } });
            } catch (IOException e) {
                return;
            }
        }
    }

    private void serve(Socket client, String upstream) {
        try (Socket c = client) {
            c.setSoTimeout(120_000);
            InputStream in = c.getInputStream();
            OutputStream out = c.getOutputStream();
            String head = readHead(in);
            if (head == null) return;
            String[] lines = head.split("\r\n");
            String[] request = lines[0].split(" ");
            if (request.length < 3 || !request[1].startsWith("/")) { respond(out, 400, null, new byte[0]); return; }

            String origin = null;
            String contentType = null;
            String apiKey = null;
            Map<String, String> swap = new java.util.LinkedHashMap<>();
            long length = 0;
            for (int i = 1; i < lines.length; i++) {
                int colon = lines[i].indexOf(':');
                if (colon < 0) continue;
                String name = lines[i].substring(0, colon).trim().toLowerCase();
                String value = lines[i].substring(colon + 1).trim();
                if ("origin".equals(name)) origin = value;
                else if ("content-type".equals(name)) contentType = value;
                else if ("tron-pro-api-key".equals(name)) apiKey = value;
                else if ("x-api-key".equals(name)) swap.put("x-api-key", value);
                else if ("authorization".equals(name)) swap.put("Authorization", value);
                else if ("idempotency-key".equals(name)) swap.put("Idempotency-Key", value);
                else if ("x-api-secret-key".equals(name)) swap.put("X-API-SECRET-KEY", value);
                else if ("x-api-key-version".equals(name)) swap.put("X-API-KEY-VERSION", value);
                else if ("x-api-nonce".equals(name)) swap.put("X-Api-Nonce", value);
                else if ("x-api-timestamp".equals(name)) swap.put("X-Api-Timestamp", value);
                else if ("x-api-signature".equals(name)) swap.put("X-Api-Signature", value);
                else if ("ref-code".equals(name)) swap.put("Ref-Code", value);
                else if ("x-changenow-api-key".equals(name)) swap.put("x-changenow-api-key", value);
                else if ("x-kusari-route".equals(name) && value.matches("[A-Za-z0-9-]{1,64}")) swap.put(ROUTE, value);
                else if ("content-length".equals(name)) length = Long.parseLong(value);
            }
            if (allowedOrigin != null && origin != null && !allowedOrigin.equals(origin)) { respond(out, 403, null, new byte[0]); return; }
            if (length < 0 || length > MAX_BODY) { respond(out, 413, origin, new byte[0]); return; }
            if ("OPTIONS".equals(request[0])) { respond(out, 204, origin, new byte[0]); return; }
            // DELETE carries its parameters in the URL (Aster cancels orders this way), never a body.
            if (!"GET".equals(request[0]) && !"POST".equals(request[0]) && !"DELETE".equals(request[0])) { respond(out, 405, origin, new byte[0]); return; }

            byte[] body = readBody(in, (int) length);
            forward(out, upstream + request[1], request[0], contentType, apiKey, swap, body, origin);
        } catch (IOException | NumberFormatException e) {
            // The WebView sees a failed request, and the wallet code reports it.
        }
    }

    private void forward(OutputStream out, String url, String method, String contentType, String apiKey, Map<String, String> swap, byte[] body, String origin) throws IOException {
        int socks = socksPort;
        // Routed requests are CoinJoin's: they only ever leave through Tor.
        if (socks <= 0 && swap.containsKey(ROUTE)) { respond(out, 502, origin, new byte[0]); return; }
        if (socks > 0) {
            try {
                forwardSocks(out, socks, new URL(url), method, contentType, apiKey, swap, body, origin);
            } catch (IOException | RuntimeException e) {
                respond(out, 502, origin, new byte[0]); // never falls back to a direct connection
            }
            return;
        }
        HttpURLConnection up = null;
        try {
            up = (HttpURLConnection) new URL(url).openConnection();
            up.setConnectTimeout(30_000);
            up.setReadTimeout(120_000);
            up.setInstanceFollowRedirects(false);
            up.setUseCaches(false);
            up.setRequestMethod(method);
            up.setRequestProperty("User-Agent", "KusariWallet");
            up.setRequestProperty("Accept", "application/json");
            if (contentType != null) up.setRequestProperty("Content-Type", contentType);
            if (apiKey != null) up.setRequestProperty("TRON-PRO-API-KEY", apiKey);
            for (Map.Entry<String, String> e : swap.entrySet()) up.setRequestProperty(e.getKey(), e.getValue());
            if ("POST".equals(method)) {
                up.setDoOutput(true);
                up.setFixedLengthStreamingMode(body.length);
                try (OutputStream o = up.getOutputStream()) { o.write(body); }
            }
            int status = up.getResponseCode();
            InputStream stream = status >= 400 ? up.getErrorStream() : up.getInputStream();
            byte[] data = stream == null ? new byte[0] : readAll(stream);
            StringBuilder extra = new StringBuilder();
            List<String> type = up.getHeaderFields().get("Content-Type");
            if (type != null && !type.isEmpty()) extra.append("Content-Type: ").append(type.get(0)).append("\r\n");
            respond(out, status, origin, data, extra.toString());
        } catch (IOException e) {
            respond(out, 502, origin, new byte[0]);
        } finally {
            if (up != null) up.disconnect();
        }
    }

    /** Plain sockets on purpose: the hostname has to reach the proxy unresolved, for privacy and for .onion names. */
    private void forwardSocks(OutputStream out, int socks, URL url, String method, String contentType, String apiKey, Map<String, String> swap, byte[] body, String origin) throws IOException {
        String host = url.getHost();
        boolean tls = "https".equals(url.getProtocol());
        int port = url.getPort() > 0 ? url.getPort() : (tls ? 443 : 80);
        byte[] name = host.getBytes(StandardCharsets.US_ASCII);
        if (name.length == 0 || name.length > 255) throw new IOException("bad host");
        try (Socket raw = new Socket(InetAddress.getByName("127.0.0.1"), socks)) {
            raw.setSoTimeout(120_000);
            InputStream si = raw.getInputStream();
            OutputStream so = raw.getOutputStream();
            so.write(new byte[] { 5, 2, 0, 2 });
            so.flush();
            if (si.read() != 5) throw new IOException("socks hello");
            int chosen = si.read();
            if (chosen == 2) {
                // Tor keeps different logins on different routes, so each host gets its own. The login goes no further than the local Tor.
                String routeName = swap.get(ROUTE);
                byte[] user = (Integer.toHexString(host.hashCode()) + "-" + routeGeneration + (routeName != null ? "-" + routeName : "")).getBytes(StandardCharsets.US_ASCII);
                ByteArrayOutputStream login = new ByteArrayOutputStream();
                login.write(new byte[] { 1, (byte) user.length });
                login.write(user);
                login.write(new byte[] { 1, 'x' });
                so.write(login.toByteArray());
                so.flush();
                if (si.read() != 1 || si.read() != 0) throw new IOException("socks login");
            } else if (chosen != 0) {
                throw new IOException("socks hello");
            }
            ByteArrayOutputStream req = new ByteArrayOutputStream();
            req.write(new byte[] { 5, 1, 0, 3, (byte) name.length });
            req.write(name);
            req.write((port >> 8) & 255);
            req.write(port & 255);
            so.write(req.toByteArray());
            so.flush();
            byte[] reply = readBody(si, 4);
            if (reply[0] != 5 || reply[1] != 0) throw new IOException("socks refused");
            int skip = reply[3] == 1 ? 6 : reply[3] == 4 ? 18 : reply[3] == 3 ? si.read() + 2 : -1;
            if (skip < 0) throw new IOException("socks reply");
            readBody(si, skip);

            Socket conn = raw;
            if (tls) {
                SSLSocket ssl = (SSLSocket) ((SSLSocketFactory) SSLSocketFactory.getDefault()).createSocket(raw, host, port, false);
                SSLParameters params = ssl.getSSLParameters();
                params.setEndpointIdentificationAlgorithm("HTTPS"); // checks the certificate matches this host
                ssl.setSSLParameters(params);
                ssl.startHandshake();
                conn = ssl;
            }
            OutputStream o = conn.getOutputStream();
            InputStream i = conn.getInputStream();
            String path = (url.getPath().isEmpty() ? "/" : url.getPath()) + (url.getQuery() != null ? "?" + url.getQuery() : "");
            boolean defaultPort = url.getPort() <= 0;
            StringBuilder h = new StringBuilder(method).append(' ').append(path).append(" HTTP/1.1\r\n");
            h.append("Host: ").append(host).append(defaultPort ? "" : ":" + port).append("\r\n");
            boolean routed = swap.containsKey(ROUTE);
            // A routed (CoinJoin) request carries only what Wasabi's own client sends, so it can't be told apart.
            if (!routed) h.append("User-Agent: KusariWallet\r\nAccept: application/json\r\nAccept-Encoding: identity\r\nConnection: close\r\n");
            if (contentType != null) h.append("Content-Type: ").append(contentType).append("\r\n");
            if (apiKey != null && !routed) h.append("TRON-PRO-API-KEY: ").append(apiKey).append("\r\n");
            for (Map.Entry<String, String> e : swap.entrySet()) if (!routed && !ROUTE.equals(e.getKey())) h.append(e.getKey()).append(": ").append(e.getValue()).append("\r\n");
            if ("POST".equals(method)) h.append("Content-Length: ").append(body.length).append("\r\n");
            h.append("\r\n");
            o.write(h.toString().getBytes(StandardCharsets.ISO_8859_1));
            if ("POST".equals(method)) o.write(body);
            o.flush();

            String head = readHead(i);
            if (head == null) throw new IOException("no response");
            String[] lines = head.split("\r\n");
            String[] statusLine = lines[0].split(" ");
            int status = Integer.parseInt(statusLine[1]);
            String type = null;
            boolean chunked = false;
            long length = -1;
            for (int n = 1; n < lines.length; n++) {
                int colon = lines[n].indexOf(':');
                if (colon < 0) continue;
                String key = lines[n].substring(0, colon).trim().toLowerCase();
                String value = lines[n].substring(colon + 1).trim();
                if ("content-type".equals(key)) type = value;
                else if ("transfer-encoding".equals(key)) chunked = value.toLowerCase().contains("chunked");
                else if ("content-length".equals(key)) length = Long.parseLong(value);
            }
            if (length > MAX_BODY * 2L) throw new IOException("response too large");
            byte[] data = chunked ? readChunked(i) : length >= 0 ? readBody(i, (int) length) : readAll(i);
            respond(out, status, origin, data, type == null ? "" : "Content-Type: " + type + "\r\n");
        }
    }

    private static byte[] readChunked(InputStream in) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        while (true) {
            StringBuilder line = new StringBuilder();
            int b;
            while ((b = in.read()) != -1 && b != '\n') { if (b != '\r') line.append((char) b); }
            if (b == -1) throw new IOException("short chunk");
            int semi = line.indexOf(";");
            int size = Integer.parseInt((semi >= 0 ? line.substring(0, semi) : line.toString()).trim(), 16);
            if (size == 0) return buf.toByteArray();
            if (buf.size() + size > MAX_BODY * 2L) throw new IOException("response too large");
            buf.write(readBody(in, size));
            readBody(in, 2);
        }
    }

    private static String readHead(InputStream in) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        int matched = 0;
        int b;
        byte[] end = {13, 10, 13, 10};
        while ((b = in.read()) != -1) {
            buf.write(b);
            if (buf.size() > MAX_HEADER) return null;
            matched = b == end[matched] ? matched + 1 : (b == 13 ? 1 : 0);
            if (matched == 4) return new String(buf.toByteArray(), 0, buf.size() - 4, StandardCharsets.ISO_8859_1);
        }
        return null;
    }

    private static byte[] readBody(InputStream in, int length) throws IOException {
        byte[] body = new byte[length];
        int off = 0;
        while (off < length) {
            int n = in.read(body, off, length - off);
            if (n < 0) throw new IOException("short body");
            off += n;
        }
        return body;
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] chunk = new byte[65536];
        int n;
        while ((n = in.read(chunk)) != -1) {
            buf.write(chunk, 0, n);
            if (buf.size() > MAX_BODY * 2) throw new IOException("response too large");
        }
        return buf.toByteArray();
    }

    private static void respond(OutputStream out, int status, String origin, byte[] data) throws IOException {
        respond(out, status, origin, data, "");
    }

    private static void respond(OutputStream out, int status, String origin, byte[] data, String extraHeaders) throws IOException {
        StringBuilder h = new StringBuilder("HTTP/1.1 ").append(status).append(" X\r\n");
        if (origin != null) {
            h.append("Access-Control-Allow-Origin: ").append(origin).append("\r\n");
            h.append("Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS\r\n");
            h.append("Access-Control-Allow-Headers: Content-Type, Accept, Authorization, TRON-PRO-API-KEY, x-api-key, X-API-SECRET-KEY, X-API-KEY-VERSION, X-Api-Nonce, X-Api-Timestamp, X-Api-Signature, Ref-Code, Idempotency-Key, x-changenow-api-key\r\n");
            h.append("Access-Control-Max-Age: 600\r\n");
        }
        h.append(extraHeaders);
        h.append("Content-Length: ").append(data.length).append("\r\nConnection: close\r\n\r\n");
        out.write(h.toString().getBytes(StandardCharsets.ISO_8859_1));
        out.write(data);
        out.flush();
    }
}
