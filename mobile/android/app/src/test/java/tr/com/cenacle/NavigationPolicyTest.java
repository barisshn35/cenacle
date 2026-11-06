// SPDX-License-Identifier: AGPL-3.0-only
package tr.com.cenacle;

import static org.junit.Assert.assertEquals;

import tr.com.cenacle.NavigationPolicy.Decision;
import org.junit.Test;

public class NavigationPolicyTest {

    private static final String LOCAL = "https://localhost";
    private static final String SERVER = "https://chat.example.com/c/general";

    private static Decision decide(String current, String target, boolean redirect, boolean gesture) {
        return NavigationPolicy.decide(LOCAL, current, target, redirect, gesture);
    }

    @Test
    public void thePairingPageOpensTheServer() {
        assertEquals(Decision.STAY, decide("https://localhost/index.html", "https://chat.example.com/", false, true));
        assertEquals(Decision.STAY, decide(null, "https://chat.example.com/", false, false));
    }

    @Test
    public void theServerAndItsSignInStayInTheApp() {
        assertEquals(Decision.STAY, decide(SERVER, "https://chat.example.com/c/random", false, true));
        // server -> Cenacle ID -> the organization's provider, by redirect or form post
        assertEquals(Decision.STAY, decide(SERVER, "https://id.example.com/auth", true, true));
        assertEquals(Decision.STAY, decide("https://id.example.com/i/1", "https://sso.example.org/saml", false, false));
    }

    @Test
    public void linksToOtherSitesOpenInTheBrowser() {
        assertEquals(Decision.BROWSER, decide(SERVER, "https://evil.example/", false, true));
        assertEquals(Decision.BROWSER, decide(SERVER, "http://chat.example.com:8080/", false, true));
        assertEquals(Decision.BROWSER, decide("https://id.example.com/account", "https://evil.example/", false, true));
    }

    @Test
    public void theAppAndOtherSchemesAreCapacitors() {
        assertEquals(Decision.DEFAULT, decide(SERVER, "https://localhost/index.html", false, true));
        assertEquals(Decision.DEFAULT, decide(SERVER, "mailto:someone@example.com", false, true));
        assertEquals(Decision.DEFAULT, decide(SERVER, "intent://scan/#Intent;end", false, true));
        assertEquals(Decision.DEFAULT, decide(SERVER, "not a url", false, true));
    }
}
