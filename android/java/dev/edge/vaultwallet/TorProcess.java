package dev.edge.vaultwallet;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Runs the bundled Tor program and reports its progress. Restarts it if it dies. */
final class TorProcess {
    interface Listener { void onState(String phase, int percent, String error); }

    private static final Pattern BOOT = Pattern.compile("Bootstrapped (\\d+)%");
    private final File exe;
    private final File dataDir;
    private final Listener listener;
    private Process process;
    private int port;
    private boolean wanted;
    private String lastLine = "";

    TorProcess(File exe, File dataDir, Listener listener) {
        this.exe = exe;
        this.dataDir = dataDir;
        this.listener = listener;
    }

    boolean available() { return exe.exists(); }

    /** Picks the SOCKS port. The forwarder points at it before Tor runs, so traffic can't go around it. */
    synchronized int prepare() throws IOException {
        if (port == 0) {
            try (ServerSocket s = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))) {
                port = s.getLocalPort();
            }
        }
        return port;
    }

    synchronized void start() {
        wanted = true;
        if (process != null) return;
        if (!exe.exists()) { listener.onState("error", 0, "Tor is not available on this device."); return; }
        try {
            prepare();
            if (!dataDir.exists() && !dataDir.mkdirs()) throw new IOException("data dir");
            ProcessBuilder pb = new ProcessBuilder(Arrays.asList(
                    exe.getAbsolutePath(),
                    "--ignore-missing-torrc", "-f", new File(dataDir, "no-torrc").getAbsolutePath(),
                    "--defaults-torrc", new File(dataDir, "no-defaults").getAbsolutePath(),
                    "--SocksPort", "127.0.0.1:" + port,
                    "--DataDirectory", dataDir.getAbsolutePath(),
                    "--ClientOnly", "1",
                    "--AvoidDiskWrites", "1",
                    "--Log", "notice stdout"));
            pb.redirectErrorStream(true);
            pb.environment().put("HOME", dataDir.getAbsolutePath());
            pb.directory(dataDir);
            final Process p = pb.start();
            process = p;
            listener.onState("starting", 0, "");
            Thread reader = new Thread(new Runnable() {
                @Override public void run() { watch(p); }
            }, "tor-log");
            reader.setDaemon(true);
            reader.start();
        } catch (IOException e) {
            listener.onState("error", 0, "Could not start Tor. " + e.getMessage());
        }
    }

    private void watch(Process p) {
        try (BufferedReader in = new BufferedReader(new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = in.readLine()) != null) {
                lastLine = line;
                Matcher m = BOOT.matcher(line);
                if (m.find()) {
                    int percent = Integer.parseInt(m.group(1));
                    listener.onState(percent >= 100 ? "ready" : "starting", percent, "");
                }
            }
        } catch (IOException ignored) { }
        boolean restart;
        synchronized (this) {
            if (process == p) process = null;
            restart = wanted;
        }
        if (!restart) return;
        // Nothing listens on the port now, so wallet traffic fails rather than leaving unprotected.
        listener.onState("error", 0, "Tor stopped. Restarting it. " + lastLine);
        try { Thread.sleep(5000); } catch (InterruptedException e) { return; }
        synchronized (this) { if (wanted) start(); }
    }

    synchronized void stop() {
        wanted = false;
        if (process != null) {
            process.destroy();
            process = null;
        }
        listener.onState("off", 0, "");
    }
}
