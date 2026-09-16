package com.lyf.llmnaitoolbox.mobile;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.widget.Toast;
import androidx.core.content.FileProvider;
import java.io.File;
import java.io.FileOutputStream;

/**
 * 页面能调用的那点原生能力，注入名 `NaiShell`。
 *
 * 目前只有一件事：把图片交给系统的分享面板。WebView 不支持 Web Share API（浏览器里才有），
 * 壳里不接这座桥就只能干看着。
 *
 * **图片字节由页面自己取好再传进来**（dataURL），不在原生这边下载：页面那边连接是现成的——
 * 用户点过「仍要继续」的自签证书、配对令牌都在 WebView 里，原生另起一条 HttpURLConnection
 * 这些全都要重来一遍，自签证书那关根本过不去。
 */
public class ShellBridge {

    public static final String NAME = "NaiShell";

    private final Activity activity;

    public ShellBridge(Activity activity) {
        this.activity = activity;
    }

    /** 页面据此判断有没有壳可用（浏览器里这个对象根本不存在） */
    @JavascriptInterface
    public boolean available() {
        return true;
    }

    /**
     * 把一张图交给系统分享面板。
     *
     * @param dataUrl  `data:image/png;base64,...`，由页面 fetch 图片后转出来
     * @param filename 分享出去时的文件名，例如 00001-3163646731.png
     */
    @JavascriptInterface
    public void shareImage(String dataUrl, String filename) {
        try {
            int comma = dataUrl == null ? -1 : dataUrl.indexOf(',');
            if (comma < 0) {
                toast("分享失败：图片数据不完整");
                return;
            }
            String meta = dataUrl.substring(0, comma);
            byte[] bytes = Base64.decode(dataUrl.substring(comma + 1), Base64.DEFAULT);

            String mime = "image/png";
            int colon = meta.indexOf(':');
            int semi = meta.indexOf(';');
            if (colon >= 0 && semi > colon) {
                mime = meta.substring(colon + 1, semi);
            }

            // 落在 cache/shared 下：FileProvider 的 cache-path 已经指向这里（res/xml/file_paths.xml），
            // 而且系统会自己回收，不用管清理
            File dir = new File(activity.getCacheDir(), "shared");
            if (!dir.exists() && !dir.mkdirs()) {
                toast("分享失败：建不了临时目录");
                return;
            }
            String safeName = (filename == null || filename.trim().isEmpty()) ? "image.png" : filename.replaceAll("[\\\\/:*?\"<>|]", "_");
            File file = new File(dir, safeName);
            try (FileOutputStream out = new FileOutputStream(file)) {
                out.write(bytes);
            }

            Uri uri = FileProvider.getUriForFile(activity, activity.getPackageName() + ".fileprovider", file);
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType(mime);
            send.putExtra(Intent.EXTRA_STREAM, uri);
            // 不给这个标志的话，接收方（相册、聊天应用）打不开这个 content:// 地址
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            activity.startActivity(Intent.createChooser(send, "分享图片"));
        } catch (Exception e) {
            toast("分享失败：" + e.getMessage());
        }
    }

    private void toast(String text) {
        activity.runOnUiThread(() -> Toast.makeText(activity, text, Toast.LENGTH_LONG).show());
    }
}
