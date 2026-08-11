package io.github.syouro.claudehistory;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.KeyEvent;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

public class MainActivity extends Activity {
    static final String PREFS = "viewer";
    static final String KEY_URL = "serverUrl";

    private WebView web;
    private String home = "";

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        home = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_URL, "");
        if (home.isEmpty()) {
            startActivity(new Intent(this, SetupActivity.class));
            finish();
            return;
        }

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(web, true);

        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                Uri u = req.getUrl();
                if ("app".equals(u.getScheme())) {
                    if ("settings".equals(u.getHost())) openSetup();
                    else v.loadUrl(home);
                    return true;
                }
                // 同域留在壳内，外链交给系统浏览器
                String h = Uri.parse(home).getHost();
                if (u.getHost() != null && u.getHost().equals(h)) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) {}
                return true;
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame()) showError(v, String.valueOf(err.getDescription()));
            }
        });
        // 下载（如导出 MD）交给系统浏览器处理
        web.setDownloadListener((url, ua, cd, mime, len) -> {
            try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); } catch (Exception ignored) {}
        });

        setContentView(web);
        if (state != null) web.restoreState(state);
        else web.loadUrl(home);
    }

    private void showError(WebView v, String detail) {
        String html = "<!doctype html><meta charset=utf-8>"
                + "<meta name=viewport content='width=device-width,initial-scale=1'>"
                + "<body style='background:#1a1a1a;color:#ddd;font-family:sans-serif;padding:2em'>"
                + "<h3>" + getString(R.string.error_title) + "</h3>"
                + "<p style='color:#888;word-break:break-all'>" + detail + "</p>"
                + "<p><a style='color:#e8a87c' href='app://reload'>" + getString(R.string.error_retry)
                + "</a>&emsp;<a style='color:#e8a87c' href='app://settings'>"
                + getString(R.string.error_settings) + "</a></p>";
        v.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    private void openSetup() {
        startActivity(new Intent(this, SetupActivity.class));
    }

    @Override
    protected void onNewIntent(Intent i) {
        super.onNewIntent(i);
        // 设置页保存后带 CLEAR_TOP 回来：重读地址并重新加载
        String u = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_URL, "");
        if (!u.isEmpty() && web != null) {
            home = u;
            web.loadUrl(home);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state);
        if (web != null) web.saveState(state);
    }

    // 返回键：短按 = 网页后退（到底则退到后台）；长按 = 打开服务器设置
    @Override
    public boolean onKeyDown(int code, KeyEvent e) {
        if (code == KeyEvent.KEYCODE_BACK) {
            e.startTracking();
            return true;
        }
        return super.onKeyDown(code, e);
    }

    @Override
    public boolean onKeyLongPress(int code, KeyEvent e) {
        if (code == KeyEvent.KEYCODE_BACK) {
            openSetup();
            return true;
        }
        return super.onKeyLongPress(code, e);
    }

    @Override
    public boolean onKeyUp(int code, KeyEvent e) {
        if (code == KeyEvent.KEYCODE_BACK && !e.isCanceled()) {
            if (web != null && web.canGoBack()) web.goBack();
            else moveTaskToBack(true);
            return true;
        }
        return super.onKeyUp(code, e);
    }
}
