// SPDX-License-Identifier: AGPL-3.0-only

package email

import (
	"strings"
	"testing"
)

func TestCard(t *testing.T) {
	raw := strings.ReplaceAll(`From: =?UTF-8?Q?Ay=C5=9Fe_Y=C4=B1lmaz?= <ayse@example.com>
Subject: =?UTF-8?B?QmFrxLFtIHlhcsSxbg==?=
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="b1"

--b1
Content-Type: multipart/alternative; boundary="b2"

--b2
Content-Type: text/html; charset=utf-8
Content-Transfer-Encoding: quoted-printable

<p>Saat <b>09:00</b>&#39;da</p><script>x()</script>
--b2--
--b1
Content-Type: application/pdf; name="plan.pdf"
Content-Disposition: attachment; filename="plan.pdf"
Content-Transfer-Encoding: base64

JVBERi0=
--b1--
`, "\n", "\r\n")
	card, ok, err := Card([]byte(raw))
	if err != nil || !ok {
		t.Fatalf("card: %v", err)
	}
	if *card.Title != "Bakım yarın" || *card.Text != "Saat 09:00'da" {
		t.Errorf("title %q text %q", *card.Title, *card.Text)
	}
	fields := *card.Fields
	if fields[0].Value != "Ayşe Yılmaz <ayse@example.com>" || fields[1].Value != "plan.pdf" {
		t.Errorf("fields = %+v", fields)
	}

	simple, _, err := Card([]byte("From: ops@example.com\r\nSubject: Disk\r\n\r\nDisk 90% full\r\n"))
	if err != nil || *simple.Text != "Disk 90% full" {
		t.Errorf("simple = %+v %v", simple, err)
	}
	if _, _, err := Card([]byte("not an e-mail")); err == nil {
		t.Error("garbage accepted")
	}
}
