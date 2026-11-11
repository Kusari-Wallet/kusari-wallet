package dev.edge.vaultwallet;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.util.Base64;

/** Drives TcpBridge from stdin for tests: "allow PORT", "socks PORT", "open ID HOST PORT", "write ID B64", "close ID". */
public final class TcpHarness {
    public static void main(String[] args) throws Exception {
        final Object out = new Object();
        TcpBridge.Listener l = new TcpBridge.Listener() {
            @Override public void onOpen(int id) { say("open " + id); }
            @Override public void onData(int id, byte[] data, int length) {
                byte[] b = new byte[length];
                System.arraycopy(data, 0, b, 0, length);
                say("data " + id + " " + Base64.getEncoder().encodeToString(b));
            }
            @Override public void onClose(int id, String error) { say("close " + id + " " + error); }
            private void say(String s) { synchronized (out) { System.out.println(s); System.out.flush(); } }
        };
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in));
        TcpBridge bridge = new TcpBridge(l, Integer.parseInt(args[0]));
        for (String line; (line = in.readLine()) != null; ) {
            String[] p = line.split(" ");
            String r;
            switch (p[0]) {
                case "socks": bridge.setSocksPort(Integer.parseInt(p[1])); r = "ok"; break;
                case "open": r = String.valueOf(bridge.open(Integer.parseInt(p[1]), p[2], Integer.parseInt(p[3]))); break;
                case "write": r = String.valueOf(bridge.write(Integer.parseInt(p[1]), Base64.getDecoder().decode(p[2]))); break;
                case "close": bridge.close(Integer.parseInt(p[1]), ""); r = "ok"; break;
                default: r = "?";
            }
            synchronized (out) { System.out.println("r " + r); System.out.flush(); }
        }
        bridge.closeAll();
        System.exit(0);
    }
}
