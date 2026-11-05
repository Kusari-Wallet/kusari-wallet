package app.probe;

import android.app.Activity;
import android.os.Bundle;
import android.util.Log;
import android.webkit.ConsoleMessage;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;

/** Answers one question: can this WebView run multi-threaded WebAssembly? Used only by a manual workflow. */
public class Main extends Activity {
  private static final String PAGE = "<!doctype html><script>"
    + "const log=m=>console.log('PROBE '+m);"
    + "log('isolated='+self.crossOriginIsolated);"
    + "log('sab='+(typeof SharedArrayBuffer));"
    + "log('ua='+navigator.userAgent);"
    + "try{const m=new WebAssembly.Memory({initial:1,maximum:2,shared:true});log('sharedMemory='+(m.buffer instanceof SharedArrayBuffer));"
    + "const w=new Worker('/w.js');w.onmessage=e=>{log('workerWrote='+new Int32Array(m.buffer)[0]);log('done')};"
    + "w.onerror=e=>{log('workerError='+e.message);log('done')};w.postMessage(m)}"
    + "catch(e){log('error='+e.message);log('done')}"
    + "</script>";
  private static final String WORKER = "onmessage=e=>{new Int32Array(e.data.buffer)[0]=42;postMessage(1)}";

  private static WebResourceResponse reply(String mime, String body) {
    HashMap<String, String> h = new HashMap<>();
    h.put("Cross-Origin-Opener-Policy", "same-origin");
    h.put("Cross-Origin-Embedder-Policy", "require-corp");
    h.put("Cross-Origin-Resource-Policy", "same-origin");
    return new WebResourceResponse(mime, "utf-8", 200, "OK", h,
      new ByteArrayInputStream(body.getBytes(StandardCharsets.UTF_8)));
  }

  @Override protected void onCreate(Bundle b) {
    super.onCreate(b);
    WebView v = new WebView(this);
    v.getSettings().setJavaScriptEnabled(true);
    android.content.pm.PackageInfo p = WebView.getCurrentWebViewPackage();
    Log.i("PROBE", "PROBE webview=" + (p == null ? "none" : p.packageName + " " + p.versionName));
    v.setWebChromeClient(new WebChromeClient() {
      @Override public boolean onConsoleMessage(ConsoleMessage m) { Log.i("PROBE", m.message()); return true; }
    });
    v.setWebViewClient(new WebViewClient() {
      @Override public WebResourceResponse shouldInterceptRequest(WebView w, WebResourceRequest r) {
        String path = r.getUrl().getPath();
        if ("/w.js".equals(path)) return reply("text/javascript", WORKER);
        return reply("text/html", PAGE);
      }
    });
    setContentView(v);
    v.loadUrl("https://app.local/");
  }
}
