package dev.edge.vaultwallet;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.util.Collections;

/** Runs a coin engine from the APK. Lines go in and out as they are; nothing here is logged or kept. */
final class ZecProcess {
    interface Listener { void onLine(String line); void onExit(); }

    private final File exe;
    private final File dir;
    private final Listener listener;
    private Process process;
    private BufferedWriter in;

    ZecProcess(File exe, File dir, Listener listener) {
        this.exe = exe;
        this.dir = dir;
        this.listener = listener;
    }

    boolean available() { return exe.exists(); }

    synchronized boolean start() {
        stop();
        if (!exe.exists()) return false;
        try {
            if (!dir.exists() && !dir.mkdirs()) return false;
            ProcessBuilder pb = new ProcessBuilder(Collections.singletonList(exe.getAbsolutePath()));
            pb.directory(dir);
            pb.environment().put("HOME", dir.getAbsolutePath());
            // Installed as libraries so that Android unpacks them; the Zcash engine checks their hash on load.
            pb.environment().put("ZEC_SAPLING_SPEND", new File(exe.getParentFile(), "libzecspend.so").getAbsolutePath());
            pb.environment().put("ZEC_SAPLING_OUTPUT", new File(exe.getParentFile(), "libzecoutput.so").getAbsolutePath());
            pb.environment().put("ARRR_SAPLING_SPEND", new File(exe.getParentFile(), "libzecspend.so").getAbsolutePath());
            pb.environment().put("ARRR_SAPLING_OUTPUT", new File(exe.getParentFile(), "libzecoutput.so").getAbsolutePath());
            final Process p = pb.start();
            process = p;
            in = new BufferedWriter(new OutputStreamWriter(p.getOutputStream(), StandardCharsets.UTF_8));
            Thread reader = new Thread(new Runnable() {
                @Override public void run() { watch(p); }
            }, "zec-out");
            reader.setDaemon(true);
            reader.start();
            Thread drain = new Thread(new Runnable() {
                @Override public void run() {
                    byte[] skip = new byte[4096];
                    try { while (p.getErrorStream().read(skip) >= 0) { /* never kept */ } } catch (IOException ignored) { }
                }
            }, "zec-err");
            drain.setDaemon(true);
            drain.start();
            return true;
        } catch (IOException e) {
            return false;
        }
    }

    private void watch(Process p) {
        try (BufferedReader out = new BufferedReader(new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = out.readLine()) != null) listener.onLine(line);
        } catch (IOException ignored) { }
        synchronized (this) {
            if (process != p) return;
            process = null;
            in = null;
        }
        listener.onExit();
    }

    synchronized boolean write(String line) {
        if (in == null) return false;
        try {
            in.write(line);
            in.newLine();
            in.flush();
            return true;
        } catch (IOException e) {
            return false;
        }
    }

    synchronized void stop() {
        if (process != null) {
            process.destroy();
            process = null;
            in = null;
        }
    }
}
