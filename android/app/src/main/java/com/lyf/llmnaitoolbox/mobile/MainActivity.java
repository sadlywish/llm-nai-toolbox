package com.lyf.llmnaitoolbox.mobile;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

/**
 * 手机端的壳：一个 WebView，先加载内置的连接页，填好地址后加载电脑托管的手机端页面。
 *
 * 不走 Capacitor 的 BridgeActivity：它带一套本地资源服务器，会按 allowNavigation 注册的
 * authority 拦截请求去 assets 里找文件。要允许「任意地址」就得把 authority 配成 `*`，
 * 而那会让它把**所有** http/https 请求都当本地资源处理——实机表现就是点了连接毫无反应
 * （用户 2026-09-17 的 HTTPS 穿透地址正是这么卡住的）。这里要的只是一个能打开任意地址、
 * 并且不把导航甩给系统浏览器的 WebView，自己写反而干净。
 */
public class MainActivity extends Activity {

    /** 连接页由 Capacitor 的 sync 拷进 assets/public（webDir 指向 src/mobile-shell） */
    private static final String SHELL_PAGE = "file:///android_asset/public/index.html";

    private WebView web;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        web = new WebView(this);
        web.setLayoutParams(
            new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        );

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        // 连接页把上次用的地址记在 localStorage 里；手机端页面本身也靠它存工作区
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(true);
        // 局域网是明文 http，穿透进来通常是 https：两种都要能开
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(false);
        // 手机端页面里有长按选中、输入法弹窗，缩放留着反而容易误触
        settings.setBuiltInZoomControls(false);

        web.setWebViewClient(
            new WebViewClient() {
                /** 一律在这个 WebView 里打开，绝不甩给系统浏览器——壳的全部意义就在这 */
                @Override
                public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                    return false;
                }

                @Override
                public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                    // 只报主文档的失败：页面里某张图挂了不该弹提示
                    if (!request.isForMainFrame()) {
                        return;
                    }
                    CharSequence reason = error.getDescription();
                    Toast
                        .makeText(MainActivity.this, "打不开：" + (reason == null ? "连接失败" : reason), Toast.LENGTH_LONG)
                        .show();
                }
            }
        );

        // 页面自己是深色的，WebView 底色跟着设，加载中间不会白闪
        web.setBackgroundColor(0xFF1E1E1E);

        setContentView(web);

        if (savedInstanceState != null) {
            web.restoreState(savedInstanceState);
        } else {
            web.loadUrl(SHELL_PAGE);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    /** 返回键先在页面里后退，退到底再退出——从电脑页面退回连接页换地址就靠它 */
    @Override
    public void onBackPressed() {
        if (web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
