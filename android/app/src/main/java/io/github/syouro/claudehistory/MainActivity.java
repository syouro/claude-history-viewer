package io.github.syouro.claudehistory;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.view.KeyEvent;
import android.webkit.CookieManager;
import android.webkit.HttpAuthHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.LinearLayout;

public class MainActivity extends Activity {
    static final String PREFS = "viewer";
    static final String KEY_URL = "serverUrl";
    static final String KEY_HTTP_USER = "httpUser";
    static final String KEY_HTTP_PASS = "httpPass";

    private WebView web;
    private String home = "";
    private boolean triedSavedAuth = false;
    private ValueCallback<Uri[]> fileChooserCb; // 网页 <input type=file> 的回调
    private static final int REQ_FILE = 1;

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

        // 裸 WebChromeClient 不实现 onShowFileChooser 的话，网页里所有 <input type=file>
        // （文件页上传、对话框 📎）点了都没反应——这里接到系统文件选择器
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb,
                                             FileChooserParams params) {
                if (fileChooserCb != null) fileChooserCb.onReceiveValue(null);
                fileChooserCb = cb;
                try {
                    startActivityForResult(params.createIntent()
                            .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true), REQ_FILE);
                } catch (Exception e) {
                    fileChooserCb = null;
                    return false;
                }
                return true;
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView v, String url, Bitmap favicon) {
                triedSavedAuth = false;
            }

            // 反代加了 HTTP Basic Auth 时 WebView 不会弹浏览器那种登录框，这里补上：
            // 先用记住的凭据静默尝试，失败（或还没存过）再弹原生对话框
            @Override
            public void onReceivedHttpAuthRequest(WebView v, HttpAuthHandler h, String host, String realm) {
                SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
                String u = p.getString(KEY_HTTP_USER, "");
                if (!triedSavedAuth && !u.isEmpty()) {
                    triedSavedAuth = true;
                    h.proceed(u, p.getString(KEY_HTTP_PASS, ""));
                    return;
                }
                askHttpAuth(h, host, u);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                Uri u = req.getUrl();
                if ("app".equals(u.getScheme())) {
                    if ("settings".equals(u.getHost())) openSetup();
                    else v.loadUrl(home);
                    return true;
                }
                // 非 http(s)（about:srcdoc 等页内 iframe、data: 之类）留给 WebView 自己处理，
                // 别当外链丢给系统浏览器
                String sch = u.getScheme();
                if (sch == null || !(sch.equals("http") || sch.equals("https"))) return false;
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

    private void askHttpAuth(HttpAuthHandler h, String host, String prefillUser) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        int pad = (int) (20 * getResources().getDisplayMetrics().density);
        box.setPadding(pad, pad / 2, pad, 0);
        EditText user = new EditText(this);
        user.setHint(R.string.auth_user);
        user.setText(prefillUser);
        EditText pass = new EditText(this);
        pass.setHint(R.string.auth_pass);
        pass.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        box.addView(user);
        box.addView(pass);
        new AlertDialog.Builder(this)
                .setTitle(getString(R.string.auth_title, host))
                .setView(box)
                .setCancelable(false)
                .setPositiveButton(R.string.auth_ok, (d, w) -> {
                    String u = user.getText().toString();
                    String pw = pass.getText().toString();
                    getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                            .putString(KEY_HTTP_USER, u).putString(KEY_HTTP_PASS, pw).apply();
                    h.proceed(u, pw);
                })
                .setNegativeButton(R.string.auth_cancel, (d, w) -> h.cancel())
                .show();
    }

    @Override
    protected void onActivityResult(int req, int result, Intent data) {
        if (req == REQ_FILE) {
            if (fileChooserCb == null) return;
            Uri[] out = null;
            // parseResult 只认单选；多选结果在 clipData 里，自己拆
            if (result == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int n = data.getClipData().getItemCount();
                    out = new Uri[n];
                    for (int i = 0; i < n; i++) out[i] = data.getClipData().getItemAt(i).getUri();
                } else if (data.getData() != null) {
                    out = new Uri[]{data.getData()};
                }
            }
            fileChooserCb.onReceiveValue(out); // 取消也要回调 null，不然下次选不了
            fileChooserCb = null;
            return;
        }
        super.onActivityResult(req, result, data);
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
