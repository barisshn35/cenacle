// SPDX-License-Identifier: AGPL-3.0-only
package com.calaixo.cenacle;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

/**
 * Where a top-level navigation of the app's web view goes. The pairing page
 * opens the server it checked; the server's pages and its sign-in (Cenacle ID,
 * an organization's own provider, each by redirect) stay in the app; a link
 * someone taps to another site opens in the system browser. No page but the
 * app's own pairing page reaches Capacitor (allowNavigation is empty).
 */
final class NavigationPolicy {

    enum Decision {
        /** Not a web page of another origin: Capacitor decides. */
        DEFAULT,
        /** Load it in the app's web view. */
        STAY,
        /** Open it in the system browser. */
        BROWSER,
    }

    private NavigationPolicy() {}

    static Decision decide(String local, String current, String target, boolean redirect, boolean gesture) {
        String to = origin(target);
        if (to == null || to.equals(origin(local))) return Decision.DEFAULT;
        String from = current == null ? null : origin(current);
        if (from == null || from.equals(origin(local)) || from.equals(to)) return Decision.STAY;
        // Redirects and script navigations are the steps of a sign-in; a tap is a link.
        if (redirect || !gesture) return Decision.STAY;
        return Decision.BROWSER;
    }

    /** scheme://host:port of an http(s) URL, or null for anything else. */
    static String origin(String url) {
        if (url == null) return null;
        try {
            URI u = new URI(url);
            String scheme = u.getScheme();
            String host = u.getHost();
            if (scheme == null || host == null) return null;
            scheme = scheme.toLowerCase(Locale.ROOT);
            if (!scheme.equals("https") && !scheme.equals("http")) return null;
            int port = u.getPort();
            if (port == -1) port = scheme.equals("https") ? 443 : 80;
            return scheme + "://" + host.toLowerCase(Locale.ROOT) + ":" + port;
        } catch (URISyntaxException e) {
            return null;
        }
    }
}
