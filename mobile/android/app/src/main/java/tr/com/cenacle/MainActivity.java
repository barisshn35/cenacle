package tr.com.cenacle;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (bridge == null) return;
        // Capacitor offers every page a way to set cookies of any site; the app has no use for it.
        bridge.getWebView().removeJavascriptInterface("CapacitorCookiesAndroidInterface");
        bridge.setWebViewClient(new GuardedWebViewClient(bridge));
    }

    /** Capacitor's web view client, with the app's navigation policy in front. */
    private static final class GuardedWebViewClient extends BridgeWebViewClient {

        private final Bridge bridge;

        GuardedWebViewClient(Bridge bridge) {
            super(bridge);
            this.bridge = bridge;
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            if (!request.isForMainFrame()) return super.shouldOverrideUrlLoading(view, request);
            Uri url = request.getUrl();
            switch (
                NavigationPolicy.decide(bridge.getLocalUrl(), view.getUrl(), url.toString(), request.isRedirect(), request.hasGesture())
            ) {
                case STAY:
                    return false;
                case BROWSER:
                    try {
                        view.getContext().startActivity(new Intent(Intent.ACTION_VIEW, url));
                    } catch (ActivityNotFoundException ignored) {
                        // No browser: the link goes nowhere rather than into the app.
                    }
                    return true;
                default:
                    return super.shouldOverrideUrlLoading(view, request);
            }
        }
    }
}
