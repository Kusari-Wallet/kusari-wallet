package dev.edge.vaultwallet;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipDescription;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.PersistableBundle;
import android.util.Base64;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.PermissionRequest;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public class MainActivity extends Activity {
    private static final String HOST = "appassets.androidplatform.net";
    private static final String ORIGIN = "https://" + HOST;
    private static final List<String> EXPLORERS = Arrays.asList(
            "https://mempool.space/", "https://litecoinspace.org/", "https://www.mintscan.io/secret/", "https://nearblocks.io/", "https://bscscan.com/", "https://blockchair.com/", "https://localcoinswap.com/?rc=FE969A35", "https://cardanoscan.io/transaction/", "https://hyperevmscan.io/tx/", "https://explorer.zano.org/transaction/", "https://explorer.pirate.black/tx/", "https://etherscan.io/", "https://polygonscan.com/", "https://arbiscan.io/", "https://insight.dash.org/", "https://solscan.io/", "https://dogechain.info/", "https://explorer.firo.org/", "https://tronscan.org/", "https://nile.tronscan.org/", "https://xmrchain.net/", "https://stagenet.xmrchain.net/");

    private final LocalProxy proxy = new LocalProxy(ORIGIN);
    private volatile int torSocksPort = 0;
    private final java.util.Map<String, SocksGate> gates = new java.util.HashMap<>();
    private final TcpBridge tcp = new TcpBridge(new TcpBridge.Listener() {
        @Override public void onOpen(int id) { toPage("window.__tcp&&window.__tcp(" + id + ",'o','')"); }
        @Override public void onData(int id, byte[] data, int length) { toPage("window.__tcp&&window.__tcp(" + id + ",'d','" + Base64.encodeToString(data, 0, length, Base64.NO_WRAP) + "')"); }
        @Override public void onClose(int id, String error) { toPage("window.__tcp&&window.__tcp(" + id + ",'c'," + JSONObject.quote(error) + ")"); }
    });
    private static final int CAMERA_REQUEST = 41;
    private int cameraRequestId = -1;
    private WebView web;
    private BiometricVault biometric;
    private TorProcess tor;
    private ZecProcess zec;
    private ZecProcess zano;
    private ZecProcess arrr;
    private ZecProcess mweb;
    private ZecProcess spark;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        // Keeps seed words out of screenshots and the recent-apps preview.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        biometric = new BiometricVault(this);
        arrr = new ZecProcess(new File(getApplicationInfo().nativeLibraryDir, "libarrrbridge.so"), new File(getFilesDir(), "arrr"), new ZecProcess.Listener() {
            @Override public void onLine(String line) { toPage("window.__arrrLine&&window.__arrrLine(" + JSONObject.quote(line) + ")"); }
            @Override public void onExit() { toPage("window.__arrrExit&&window.__arrrExit()"); }
        });
        mweb = new ZecProcess(new File(getApplicationInfo().nativeLibraryDir, "libmwebbridge.so"), new File(getFilesDir(), "mweb"), new ZecProcess.Listener() {
            @Override public void onLine(String line) { toPage("window.__mwebLine&&window.__mwebLine(" + JSONObject.quote(line) + ")"); }
            @Override public void onExit() { toPage("window.__mwebExit&&window.__mwebExit()"); }
        });
        spark = new ZecProcess(new File(getApplicationInfo().nativeLibraryDir, "libsparkbridge.so"), new File(getFilesDir(), "spark"), new ZecProcess.Listener() {
            @Override public void onLine(String line) { toPage("window.__sparkLine&&window.__sparkLine(" + JSONObject.quote(line) + ")"); }
            @Override public void onExit() { toPage("window.__sparkExit&&window.__sparkExit()"); }
        });
        zano = new ZecProcess(new File(getApplicationInfo().nativeLibraryDir, "libzanobridge.so"), new File(getFilesDir(), "zano"), new ZecProcess.Listener() {
            @Override public void onLine(String line) { toPage("window.__zanoLine&&window.__zanoLine(" + JSONObject.quote(line) + ")"); }
            @Override public void onExit() { toPage("window.__zanoExit&&window.__zanoExit()"); }
        });
        zec = new ZecProcess(new File(getApplicationInfo().nativeLibraryDir, "libzecbridge.so"), new File(getFilesDir(), "zec"), new ZecProcess.Listener() {
            @Override public void onLine(String line) { toPage("window.__zecLine&&window.__zecLine(" + JSONObject.quote(line) + ")"); }
            @Override public void onExit() { toPage("window.__zecExit&&window.__zecExit()"); }
        });
        tor = new TorProcess(new File(getApplicationInfo().nativeLibraryDir, "libtor.so"), new File(getApplicationInfo().nativeLibraryDir, "liblyrebird.so"), new File(getFilesDir(), "tor"), new TorProcess.Listener() {
            @Override public void onState(String phase, int percent, String error) {
                final String script = "window.__torState&&window.__torState(" + JSONObject.quote(phase) + "," + percent + "," + JSONObject.quote(error) + ")";
                runOnUiThread(new Runnable() { @Override public void run() { if (web != null) web.evaluateJavascript(script, null); } });
            }
        });
        web = new WebView(this);
        web.setBackgroundColor(0xFF070707);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setGeolocationEnabled(false);
        s.setSaveFormData(false);
        s.setSupportMultipleWindows(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        // Pages are local assets only. This lets them reach the local forwarder over http://127.0.0.1.
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        web.addJavascriptInterface(new Bridge(), "VaultNative");
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(PermissionRequest request) {
                // QR scanning only: the app's own page, video only, after the person allowed the camera.
                String[] wanted = request.getResources();
                boolean videoOnly = wanted.length == 1 && PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(wanted[0]);
                boolean ours = HOST.equals(request.getOrigin().getHost());
                if (videoOnly && ours && checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) request.grant(wanted);
                else request.deny();
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !HOST.equals(request.getUrl().getHost());
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (!HOST.equals(url.getHost())) return null;
                return asset(url.getPath());
            }
            // Android can end the page's process while the app is in the background. Without this the screen stays
            // black on return, so the page starts over and asks for the password again.
            @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                if (view == web) {
                    web = null;
                    view.destroy();
                    recreate();
                }
                return true;
            }
        });
        setContentView(web);
        // Always a fresh start. When Android had closed the screen in the background, the page has nothing worth
        // restoring (the wallet locks anyway), and restoring it left an empty black screen.
        web.loadUrl(ORIGIN + "/index.html");
    }

    private WebResourceResponse asset(String path) {
        String name = path == null || path.equals("/") ? "index.html" : path.replaceFirst("^/+", "");
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        try {
            if (name.contains("..")) throw new IOException("bad path");
            InputStream in = getAssets().open("www/" + name);
            return new WebResourceResponse(mime(name), mime(name).startsWith("text/") ? "utf-8" : null, 200, "OK", headers, in);
        } catch (IOException e) {
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", headers, null);
        }
    }

    private static String mime(String name) {
        if (name.endsWith(".html")) return "text/html";
        if (name.endsWith(".js")) return "text/javascript";
        if (name.endsWith(".css")) return "text/css";
        if (name.endsWith(".png")) return "image/png";
        if (name.endsWith(".woff2")) return "font/woff2";
        if (name.endsWith(".wasm")) return "application/wasm";
        return "application/octet-stream";
    }

    private static final int NOTIFY_REQUEST = 7;
    private boolean askedNotifications = false;

    @Override protected void onDestroy() {
        stopService(new Intent(this, KeepRunningService.class));
        tor.stop();
        zec.stop();
        zano.stop();
        arrr.stop();
        mweb.stop();
        spark.stop();
        tcp.closeAll();
        super.onDestroy();
    }

    @Override protected void onPause() {
        super.onPause();
        if (web != null) web.evaluateJavascript("window.__appPaused && window.__appPaused()", null);
    }

    @Override public void onBackPressed() {
        if (web == null) { moveTaskToBack(true); return; }
        web.evaluateJavascript("window.__appBack && window.__appBack()", new ValueCallback<String>() {
            @Override public void onReceiveValue(String value) {
                if (!"true".equals(value)) moveTaskToBack(true);
            }
        });
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode != CAMERA_REQUEST || cameraRequestId < 0) return;
        boolean ok = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
        int id = cameraRequestId;
        cameraRequestId = -1;
        bioResult(id, ok, ok ? "" : "camera-denied");
    }

    private void bioResult(int id, boolean ok, String value) {
        final String script = "window.__bioResult(" + id + "," + ok + "," + JSONObject.quote(value) + ")";
        runOnUiThread(new Runnable() { @Override public void run() { if (web != null) web.evaluateJavascript(script, null); } });
    }

    private void toPage(final String script) {
        runOnUiThread(new Runnable() { @Override public void run() { if (web != null) web.evaluateJavascript(script, null); } });
    }

    public final class Bridge {
        @JavascriptInterface public int proxyPort(String upstream) { return proxy.portFor(upstream); }

        /** While unlocked, a foreground service keeps the process alive in the background; off again on lock. */
        @JavascriptInterface public void keepRunning(final boolean on, final String title, final String text) {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    Intent i = new Intent(MainActivity.this, KeepRunningService.class);
                    if (!on) { stopService(i); return; }
                    if (android.os.Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED && !askedNotifications) {
                        askedNotifications = true; // asked once; without it the service still runs, just without a visible notice
                        requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, NOTIFY_REQUEST);
                    }
                    i.putExtra(KeepRunningService.EXTRA_TITLE, title);
                    i.putExtra(KeepRunningService.EXTRA_TEXT, text);
                    try { startForegroundService(i); } catch (RuntimeException e) { /* not allowed right now: the app simply runs as before */ }
                }
            });
        }

        @JavascriptInterface public void openExternal(final String url) {
            boolean allowed = false;
            for (String prefix : EXPLORERS) allowed |= url.startsWith(prefix);
            if (!allowed) return;
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); } catch (ActivityNotFoundException ignored) { }
                }
            });
        }

        private ClipboardManager clipboard() { return getSystemService(ClipboardManager.class); }

        @JavascriptInterface public void copy(String text) {
            ClipData clip = ClipData.newPlainText("", text);
            PersistableBundle extras = new PersistableBundle();
            extras.putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true);
            clip.getDescription().setExtras(extras);
            clipboard().setPrimaryClip(clip);
        }

        @JavascriptInterface public void clearClip(String text) {
            ClipData clip = clipboard().getPrimaryClip();
            if (clip != null && clip.getItemCount() > 0 && text.contentEquals(clip.getItemAt(0).coerceToText(MainActivity.this))) {
                clipboard().clearPrimaryClip();
            }
        }

        @JavascriptInterface public String paste() {
            ClipData clip = clipboard().getPrimaryClip();
            return clip == null || clip.getItemCount() == 0 ? "" : String.valueOf(clip.getItemAt(0).coerceToText(MainActivity.this));
        }

        @JavascriptInterface public void cameraPermission(final int id) {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                        bioResult(id, true, "");
                        return;
                    }
                    if (cameraRequestId >= 0) bioResult(cameraRequestId, false, "camera-denied");
                    cameraRequestId = id;
                    requestPermissions(new String[] { Manifest.permission.CAMERA }, CAMERA_REQUEST);
                }
            });
        }

        @JavascriptInterface public String mwebInfo() { return zecInfo(); }
        @JavascriptInterface public boolean mwebAvailable() { return mweb.available(); }
        @JavascriptInterface public boolean mwebStart() { return mweb.start(); }
        @JavascriptInterface public boolean mwebWrite(String line) { return mweb.write(line); }
        @JavascriptInterface public void mwebStop() { mweb.stop(); }
        @JavascriptInterface public String mwebDir() { return new File(getFilesDir(), "mweb").getAbsolutePath(); }
        @JavascriptInterface public boolean sparkAvailable() { return spark.available(); }
        @JavascriptInterface public boolean sparkStart() { return spark.start(); }
        @JavascriptInterface public boolean sparkWrite(String line) { return spark.write(line); }
        @JavascriptInterface public void sparkStop() { spark.stop(); }
        @JavascriptInterface public String sparkDir() { return new File(getFilesDir(), "spark").getAbsolutePath(); }
        @JavascriptInterface public boolean arrrAvailable() { return arrr.available(); }
        @JavascriptInterface public boolean arrrStart() { return arrr.start(); }
        @JavascriptInterface public boolean arrrWrite(String line) { return arrr.write(line); }
        @JavascriptInterface public void arrrStop() { arrr.stop(); }
        @JavascriptInterface public String arrrDir() { return new File(getFilesDir(), "arrr").getAbsolutePath(); }
        @JavascriptInterface public String arrrInfo() { return zecInfo(); }
        @JavascriptInterface public boolean zanoAvailable() { return zano.available(); }
        @JavascriptInterface public boolean zanoStart() { return zano.start(); }
        @JavascriptInterface public boolean zanoWrite(String line) { return zano.write(line); }
        @JavascriptInterface public void zanoStop() { zano.stop(); }
        @JavascriptInterface public String zanoDir() { return new File(getFilesDir(), "zano").getAbsolutePath(); }
        @JavascriptInterface public String zanoInfo() { return zecInfo(); }
        @JavascriptInterface public String zecInfo() {
            File dir = new File(getApplicationInfo().nativeLibraryDir);
            String[] names = dir.list();
            return "Device " + java.util.Arrays.toString(android.os.Build.SUPPORTED_ABIS) + " / app " + dir.getName()
                + " / " + (names == null ? "no list" : java.util.Arrays.toString(names));
        }
        @JavascriptInterface public boolean zecAvailable() { return zec.available(); }
        @JavascriptInterface public boolean zecStart() { return zec.start(); }
        @JavascriptInterface public boolean zecWrite(String line) { return zec.write(line); }
        @JavascriptInterface public void zecStop() { zec.stop(); }

        @JavascriptInterface public boolean torAvailable() { return tor.available(); }

        @JavascriptInterface public int torPrepare() {
            try {
                int port = tor.prepare();
                proxy.setSocksPort(port);
                tcp.setSocksPort(port);
                torSocksPort = port;
                return port;
            } catch (IOException e) {
                return 0;
            }
        }

        @JavascriptInterface public void torNewRoute() { proxy.newRoutes(); }
        @JavascriptInterface public void torStart() { tor.start(); }
        /** Bridge lines as a JSON array, for the next start; false if any is refused. */
        @JavascriptInterface public boolean torBridges(String json) {
            try {
                org.json.JSONArray a = new org.json.JSONArray(json);
                java.util.List<String> lines = new java.util.ArrayList<>();
                for (int i = 0; i < a.length(); i++) lines.add(a.getString(i));
                return tor.setBridges(lines);
            } catch (org.json.JSONException e) { return false; }
        }
        @JavascriptInterface public boolean torHasBridges() { return new File(getApplicationInfo().nativeLibraryDir, "liblyrebird.so").exists(); }
        @JavascriptInterface public void torStop() { tor.stop(); }
        @JavascriptInterface public void torDirect() { tor.stop(); proxy.setSocksPort(0); tcp.setSocksPort(0); torSocksPort = 0; }

        /** An engine's own SOCKS port in front of Tor's (SocksGate), whose circuit socksGateRenew changes. 0 if it can't. */
        @JavascriptInterface public int socksGateStart(String name, int torPort) {
            if (torPort <= 0 || torPort > 65535) return 0;
            synchronized (gates) {
                SocksGate g = gates.get(name);
                if (g == null) {
                    try { g = new SocksGate(torPort); } catch (java.io.IOException e) { return 0; }
                    gates.put(name, g);
                } else g.setTorPort(torPort);
                return g.port();
            }
        }
        @JavascriptInterface public void socksGateRenew(String name) {
            SocksGate g;
            synchronized (gates) { g = gates.get(name); }
            if (g != null) g.renew();
        }

        /** Dash and Bitcoin peer-to-peer sockets. With requireTor, refused unless Tor's SOCKS port is set: never a direct fallback. */
        @JavascriptInterface public boolean tcpOpen(int id, String host, int port, boolean requireTor) {
            if ((requireTor || port == TcpBridge.BTC_PORT) && torSocksPort == 0) return false;
            return tcp.open(id, host, port);
        }
        @JavascriptInterface public boolean tcpWrite(int id, String data) {
            try { return tcp.write(id, Base64.decode(data, Base64.NO_WRAP)); } catch (IllegalArgumentException e) { return false; }
        }
        @JavascriptInterface public void tcpClose(int id) { tcp.close(id, ""); }

        @JavascriptInterface public boolean bioAvailable() { return biometric.available(); }
        @JavascriptInterface public boolean bioEnabled(String wallet) { return biometric.enabled(wallet); }
        @JavascriptInterface public void bioDisable(String wallet) { biometric.disable(wallet); }

        @JavascriptInterface public void bioEnable(final int id, final String wallet, final String password) {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    biometric.enable(wallet, password, new BiometricVault.Callback() {
                        @Override public void done(boolean ok, String value) { bioResult(id, ok, value); }
                    });
                }
            });
        }

        @JavascriptInterface public void bioUnlock(final int id, final String wallet) {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    biometric.unlock(wallet, new BiometricVault.Callback() {
                        @Override public void done(boolean ok, String value) { bioResult(id, ok, value); }
                    });
                }
            });
        }
    }
}
