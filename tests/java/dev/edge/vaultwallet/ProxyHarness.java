package dev.edge.vaultwallet;

import java.io.BufferedReader;
import java.io.InputStreamReader;

/** Runs the real LocalProxy on a desktop JVM for tests: each input line is an upstream, each output line its port. */
public final class ProxyHarness {
    public static void main(String[] args) throws Exception {
        LocalProxy proxy = new LocalProxy(args[0]);
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in));
        String line;
        while ((line = in.readLine()) != null) {
            if (line.equals("newroutes")) {
                proxy.newRoutes();
                System.out.println(0);
            } else if (line.startsWith("socks:")) {
                proxy.setSocksPort(Integer.parseInt(line.substring(6).trim()));
                System.out.println(0);
            } else {
                System.out.println(proxy.portFor(line.trim()));
            }
            System.out.flush();
        }
    }
}
