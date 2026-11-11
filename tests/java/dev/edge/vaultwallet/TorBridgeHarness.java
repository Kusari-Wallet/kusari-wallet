package dev.edge.vaultwallet;

import java.io.File;
import java.util.Arrays;
import java.util.Collections;

/** Prints whether TorProcess takes each set of bridge lines: args[0] is lyrebird's path. */
public final class TorBridgeHarness {
    public static void main(String[] args) {
        TorProcess t = new TorProcess(new File("/nonexistent/tor"), new File(args[0]), new File(System.getProperty("java.io.tmpdir")), (p, n, e) -> { });
        String[][] cases = {
            { "obfs4 1.2.3.4:443 AAAA cert=x iat-mode=0" },
            { "snowflake 192.0.2.3:80 2B28 fingerprint=2B28 url=https://x.example/ fronts=a.example ice=stun:s.example:3478" },
            { "webtunnel [2001:db8::1]:443 BBBB url=https://e.example/p" },
            { "obfs4 1.2.3.4:443 A\nUseBridges 0" },
            { "vanilla 1.2.3.4:9001 AAAA" },
            { "obfs4 example.com:443 AAAA" },
            { "obfs4 1.2.3.4:443 A\tB" },
        };
        StringBuilder out = new StringBuilder();
        for (String[] c : cases) out.append(t.setBridges(Arrays.asList(c)) ? '1' : '0');
        out.append(t.setBridges(Collections.<String>emptyList()) ? '1' : '0');
        System.out.println(out);
    }
}
