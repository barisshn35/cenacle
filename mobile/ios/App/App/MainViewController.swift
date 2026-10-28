// SPDX-License-Identifier: AGPL-3.0-only
import UIKit
import WebKit
import Capacitor

/// Capacitor's view controller, with the app's navigation policy.
class MainViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(NavigationGuard())
    }
}

/// Where a top-level navigation of the app's web view goes. The pairing page
/// opens the server it checked; the server's pages and its sign-in (Cenacle ID,
/// an organization's own provider, each by redirect) stay in the app; a link
/// someone taps to another site opens in the system browser. Mirrors
/// NavigationPolicy on Android; allowNavigation stays empty.
@objc(NavigationGuard)
class NavigationGuard: CAPPlugin, CAPBridgedPlugin {
    let identifier = "NavigationGuard"
    let jsName = "NavigationGuard"
    let pluginMethods: [CAPPluginMethod] = []

    /// scheme://host:port of an http(s) URL, or nil for anything else.
    static func origin(_ url: URL?) -> String? {
        guard let url = url, let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased(),
              scheme == "https" || scheme == "http" else { return nil }
        let port = url.port ?? (scheme == "https" ? 443 : 80)
        return "\(scheme)://\(host):\(port)"
    }

    override func shouldOverrideLoad(_ navigationAction: WKNavigationAction) -> NSNumber? {
        // Frames inside a page are Capacitor's (and the page's CSP's) to decide.
        if let frame = navigationAction.targetFrame, !frame.isMainFrame { return nil }
        guard let target = navigationAction.request.url, let to = Self.origin(target) else { return nil }
        let current = webView?.url
        // The app's own pages (capacitor://localhost) have no http(s) origin.
        guard let from = Self.origin(current) else { return NSNumber(value: false) }
        if from == to { return NSNumber(value: false) }
        // Redirects and script navigations are the steps of a sign-in; a tap is a link.
        if navigationAction.navigationType != .linkActivated { return NSNumber(value: false) }
        UIApplication.shared.open(target, options: [:], completionHandler: nil)
        return NSNumber(value: true)
    }
}
