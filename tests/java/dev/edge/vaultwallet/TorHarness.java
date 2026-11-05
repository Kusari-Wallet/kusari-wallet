package dev.edge.vaultwallet;

import java.io.File;

/** Runs the real TorProcess class on a desktop JVM with a tor binary given on the command line. */
public final class TorHarness {
    public static void main(String[] args) throws Exception {
        TorProcess tor = new TorProcess(new File(args[0]), new File(args[1]), new TorProcess.Listener() {
            @Override public void onState(String phase, int percent, String error) {
                System.out.println(phase + " " + percent + " " + error);
                System.out.flush();
            }
        });
        System.out.println("port " + tor.prepare());
        System.out.flush();
        tor.start();
        Thread.sleep(Long.parseLong(args[2]));
        tor.stop();
        System.out.println("stopped");
        System.exit(0);
    }
}
