package br.com.araujoempresarial.commercialinsight;

import android.content.Context;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.concurrent.atomic.AtomicBoolean;

@CapacitorPlugin(name = "NativePrint")
public class NativePrintPlugin extends Plugin {

    private WebView activePrintWebView;

    @PluginMethod
    public void printHtml(PluginCall call) {
        String html = call.getString("html");
        String rawJobName = call.getString("jobName", "Comercial Insight · Relatório Comercial");
        String jobName = rawJobName != null && !rawJobName.trim().isEmpty()
            ? rawJobName.trim()
            : "Comercial Insight";

        if (html == null || html.isEmpty()) {
            call.reject("Conteúdo de impressão ausente.");
            return;
        }

        getActivity().runOnUiThread(() -> {
            try {
                if (activePrintWebView != null) {
                    activePrintWebView.destroy();
                    activePrintWebView = null;
                }
                WebView webView = new WebView(getActivity());
                WebSettings settings = webView.getSettings();
                settings.setJavaScriptEnabled(false);
                settings.setAllowFileAccess(false);
                settings.setAllowContentAccess(false);

                AtomicBoolean finished = new AtomicBoolean(false);
                webView.setWebViewClient(new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                        return true;
                    }

                    @Override
                    public void onPageFinished(WebView view, String url) {
                        if (!finished.compareAndSet(false, true)) return;
                        try {
                            PrintManager printManager = (PrintManager) getActivity()
                                .getSystemService(Context.PRINT_SERVICE);
                            if (printManager == null) {
                                call.reject("Serviço de impressão indisponível no dispositivo.");
                                return;
                            }
                            PrintDocumentAdapter adapter = view.createPrintDocumentAdapter(jobName);
                            printManager.print(jobName, adapter, new PrintAttributes.Builder().build());
                            JSObject result = new JSObject();
                            result.put("printed", true);
                            call.resolve(result);
                        } catch (Exception ex) {
                            call.reject("Não foi possível iniciar a impressão do relatório.", ex);
                        }
                    }
                });

                activePrintWebView = webView;
                webView.loadDataWithBaseURL("about:blank", html, "text/html", "UTF-8", null);
            } catch (Exception ex) {
                call.reject("Falha ao preparar o relatório para PDF/impressão.", ex);
            }
        });
    }
}
