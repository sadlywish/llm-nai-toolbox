package com.lyf.llmnaitoolbox.mobile;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

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

    /**
     * 问页面要不要自己处理返回键。只认严格的 true：页面没装 NaiBack、正在加载、脚本抛错，
     * 回来的都不是 "true"，一律按「页面不管」走后退，不会把返回键吞掉
     */
    private static final String ASK_PAGE_BACK =
        "(function(){try{return typeof window.NaiBack==='function'&&window.NaiBack()===true}catch(e){return false}})()";

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
                    showProblem("打不开这个地址", (reason == null ? "连接失败" : reason.toString()));
                }

                @Override
                public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                    if (!request.isForMainFrame()) {
                        return;
                    }
                    showProblem("服务器回了错误", "HTTP " + response.getStatusCode());
                }

                /**
                 * 证书有问题时给用户选择权。
                 *
                 * 默认实现是**直接 cancel 且不触发 onReceivedError**——页面停在原地、一点动静都没有，
                 * 实机上就是「点了连接毫无反应」（用户 2026-09-17 用 frp 的 https 地址正是卡在这）。
                 * 浏览器会弹「继续访问」让人自己判断，壳里也照做：说清哪台主机、什么毛病，由用户决定。
                 * 不无条件 proceed——那等于把 https 降成明文，连中间人都挡不住。
                 */
                @Override
                public void onReceivedSslError(WebView view, final SslErrorHandler handler, SslError error) {
                    String host = Uri.parse(error.getUrl()).getHost();
                    String why;
                    switch (error.getPrimaryError()) {
                        case SslError.SSL_UNTRUSTED:
                            why = "证书不是系统信任的机构签发的（自签证书就会这样）";
                            break;
                        case SslError.SSL_IDMISMATCH:
                            why = "证书上的域名与这个地址对不上";
                            break;
                        case SslError.SSL_EXPIRED:
                            why = "证书已过期";
                            break;
                        case SslError.SSL_NOTYETVALID:
                            why = "证书还没到生效时间";
                            break;
                        case SslError.SSL_DATE_INVALID:
                            why = "证书的有效期不对";
                            break;
                        default:
                            why = "证书校验没通过";
                            break;
                    }
                    new AlertDialog.Builder(MainActivity.this)
                        .setTitle("证书有问题")
                        .setMessage(host + "：" + why + "。\n\n只有当这个地址确实是你自己的电脑时才继续。")
                        .setPositiveButton("仍要继续", (dialog, which) -> handler.proceed())
                        .setNegativeButton("取消", (dialog, which) -> handler.cancel())
                        .setOnCancelListener(dialog -> handler.cancel())
                        .show();
                }
            }
        );

        // 页面能调用的那点原生能力（目前只有分享图片）。注入名见 ShellBridge.NAME；
        // 浏览器里没有这个对象，页面据此自行降级到 Web Share API
        web.addJavascriptInterface(new ShellBridge(this), ShellBridge.NAME);

        // 允许用电脑的 Chrome 远程调试这个 WebView（chrome://inspect）。
        // 这次排查「点了没反应」时手上没有任何日志，太被动
        WebView.setWebContentsDebuggingEnabled(true);

        // 页面自己是深色的，WebView 底色跟着设，加载中间不会白闪
        web.setBackgroundColor(0xFF1E1E1E);

        setContentView(web);

        if (savedInstanceState != null) {
            web.restoreState(savedInstanceState);
        } else {
            web.loadUrl(SHELL_PAGE);
        }
    }

    /** 出错就摆一个对话框：Toast 一闪而过，出了问题连是什么都来不及看 */
    private void showProblem(String title, String detail) {
        new AlertDialog.Builder(this).setTitle(title).setMessage(detail).setPositiveButton("知道了", null).show();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    /**
     * 返回键先问页面，页面不管才在 WebView 里后退、退到底再退出。
     *
     * 手机端页面里的弹窗与页签切换都不产生浏览记录，只做 goBack 的话无论停在哪都是直接退回连接页
     * （用户 2026-09-17 反馈）。页面的 window.NaiBack() 负责：关最上层弹窗、详情页回列表、
     * 其他页签回工作台、工作台上连按两次才放行（见 src/mobile/src/backStack.ts）。
     * 连接页本身没有 NaiBack，回的是 false，照旧后退或退出。
     */
    @Override
    public void onBackPressed() {
        if (web == null) {
            super.onBackPressed();
            return;
        }
        web.evaluateJavascript(ASK_PAGE_BACK, value -> {
            if ("true".equals(value) || web == null) {
                return;
            }
            if (web.canGoBack()) {
                web.goBack();
            } else {
                super.onBackPressed();
            }
        });
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
