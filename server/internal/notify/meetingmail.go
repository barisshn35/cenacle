// SPDX-License-Identifier: AGPL-3.0-only

package notify

import (
	"bytes"
	"embed"
	"fmt"
	htmltemplate "html/template"
	"net/mail"
	"net/url"
	"strings"
	texttemplate "text/template"
	"time"

	"github.com/Cenacle-TR/cenacle/server/internal/meetings"
)

// Meeting e-mails (ADR 0054): an invitation, a change or a cancellation, in
// HTML and plain text with the meeting as an iCalendar file.

//go:embed mail/meeting.html.tmpl mail/meeting.txt.tmpl mail/logo.png
var mailFiles embed.FS

var (
	meetingHTML = htmltemplate.Must(htmltemplate.New("meeting.html.tmpl").Funcs(htmltemplate.FuncMap{
		// outlook writes markup only Outlook on Windows reads: it ignores
		// max-width, so the card gets a fixed width there.
		"outlook": func(s string) htmltemplate.HTML { return htmltemplate.HTML("<!--[if mso]>" + s + "<![endif]-->") }, //nolint:gosec // constant markup from the template
	}).ParseFS(mailFiles, "mail/meeting.html.tmpl"))
	meetingText = texttemplate.Must(texttemplate.ParseFS(mailFiles, "mail/meeting.txt.tmpl"))
	logoPNG, _  = mailFiles.ReadFile("mail/logo.png")
)

// MeetingMail is what one e-mail about a meeting says.
type MeetingMail struct {
	Kind string // invite, update or cancel
	// Removed: a cancel because the person was taken off the meeting (it goes on).
	Removed bool
	// Skipped: an update because one occurrence was cancelled (its start).
	Skipped *time.Time
	// WasStart and WasEnd: an update that moved the meeting.
	WasStart, WasEnd *time.Time

	MeetingID, ChannelID string
	Title, Agenda        string
	Organizer            string
	Workspace            string
	Start, End           time.Time
	TimeZone             string // the meeting's
	Rule                 string
	Exdates              []time.Time
	Sequence             int
	// The place: a channel (its name), or a direct or group conversation (its title).
	PlaceKind, PlaceName string
	People               []string // invitees who did not say no (organizer first)
	PeopleTotal          int

	Language       string // en or tr
	RecipientTZ    string
	RecipientName  string
	RecipientEmail string
	PublicURL      string
	From           string // the sender address, as the calendar's organizer
	// OrganizerEmail receives replies to the e-mail (Reply-To); empty: none.
	OrganizerEmail string
}

type mailRow struct {
	Label string
	Lines []string
}

type meetingMailData struct {
	Lang, Subject, Preheader, Workspace, Lead, Title    string
	Cancelled, TimeChanged                              bool
	Month, Day, Weekday, Time, OldTime, Zone, Repeat    string
	LongDate                                            string
	ChangedLabel, WasLabel, CancelledLabel              string
	Rows                                                []mailRow
	Button, ButtonURL, Hint, CalendarNote, Footer, Host string
}

type mailWords struct {
	months, monthsShort                                                       []string
	weekdays                                                                  []string
	invite, update, moved, skipped, cancel, removed                           string
	subjectInvite, subjectUpdate, subjectMoved, subjectSkipped, subjectCancel string
	changed, was, cancelled                                                   string
	where, host, people, agenda                                               string
	callIn, callInDirect, callInGroup, callInNamedGroup                       string
	more                                                                      string
	open, openChannel                                                         string
	hintInvite, hintUpdate, hintCancel                                        string
	calInvite, calUpdate, calCancel                                           string
	footer                                                                    string
	zone                                                                      string
	every, everyN, daily, dailyN, monthly, monthlyN, until, times, and        string
}

var words = map[string]mailWords{
	"en": {
		months:      []string{"January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"},
		monthsShort: []string{"JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"},
		weekdays:    []string{"Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"},
		invite:      "%s invited you to a meeting.", update: "%s changed this meeting.", moved: "%s changed the time of this meeting.",
		skipped: "%s cancelled the meeting on %s; the others stay.", cancel: "%s cancelled this meeting.", removed: "%s took you off this meeting.",
		subjectInvite: "Invitation: %s, %s", subjectUpdate: "Changed: %s", subjectMoved: "Changed: %s, now %s",
		subjectSkipped: "Cancelled: %s, %s", subjectCancel: "Cancelled: %s",
		changed: "Changed", was: "was", cancelled: "Cancelled",
		where: "Where", host: "Organizer", people: "Invited", agenda: "Agenda",
		callIn: "Cenacle call in %s", callInDirect: "Cenacle call in your direct conversation",
		callInGroup: "Cenacle call in a group conversation", callInNamedGroup: "Cenacle call in the %s conversation",
		more: "%s and %d more", open: "Open the meeting", openChannel: "Open the channel",
		hintInvite: "Say whether you will come in Cenacle. Join opens 5 minutes before the meeting.",
		hintUpdate: "Your answer stays; you can change it in Cenacle.",
		hintCancel: "The meeting is removed from your calendar as well.",
		calInvite:  "The attached file adds the meeting to your calendar.",
		calUpdate:  "The attached file updates it in your calendar.",
		calCancel:  "The attached file removes it from your calendar.",
		footer:     "You got this e-mail because you were invited to a meeting in the %s workspace. Turn meeting e-mails off in Settings › Notifications.",
		zone:       "%s time (GMT%s)",
		every:      "Every %s", everyN: "Every %d weeks on %s", daily: "Every day", dailyN: "Every %d days",
		monthly: "Monthly on day %d", monthlyN: "Every %d months on day %d", until: "%s until %s", times: "%s, %d times", and: " and ",
	},
	"tr": {
		months:      []string{"Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"},
		monthsShort: []string{"OCA", "ŞUB", "MAR", "NİS", "MAY", "HAZ", "TEM", "AĞU", "EYL", "EKİ", "KAS", "ARA"},
		weekdays:    []string{"Pazar", "Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi"},
		invite:      "%s sizi bir toplantıya davet etti.", update: "%s bu toplantıyı değiştirdi.", moved: "%s bu toplantının saatini değiştirdi.",
		skipped: "%s bu toplantının %s tarihli oturumunu iptal etti; diğerleri yerinde.", cancel: "%s bu toplantıyı iptal etti.",
		removed:       "%s sizi bu toplantıdan çıkardı.",
		subjectInvite: "Davet: %s, %s", subjectUpdate: "Değişti: %s", subjectMoved: "Değişti: %s, artık %s",
		subjectSkipped: "İptal edildi: %s, %s", subjectCancel: "İptal edildi: %s",
		changed: "Değişti", was: "önceden", cancelled: "İptal edildi",
		where: "Nerede", host: "Düzenleyen", people: "Katılımcılar", agenda: "Gündem",
		callIn: "Cenacle görüşmesi, %s kanalında", callInDirect: "Cenacle görüşmesi, özel konuşmanızda",
		callInGroup: "Cenacle görüşmesi, grup konuşmasında", callInNamedGroup: "Cenacle görüşmesi, %s konuşmasında",
		more: "%s ve %d kişi daha", open: "Toplantıyı aç", openChannel: "Kanalı aç",
		hintInvite: "Katılıp katılmayacağınızı Cenacle’da bildirebilirsiniz. Katıl düğmesi toplantıdan 5 dakika önce açılır.",
		hintUpdate: "Yanıtınız korunur; değiştirmek isterseniz Cenacle’da yapabilirsiniz.",
		hintCancel: "Toplantı takviminizden de kaldırılır.",
		calInvite:  "Ekteki dosya toplantıyı takviminize ekler.",
		calUpdate:  "Ekteki dosya takviminizdeki kaydı günceller.",
		calCancel:  "Ekteki dosya kaydı takviminizden siler.",
		footer:     "Bu e-postayı, %s çalışma alanında bir toplantıya davet edildiğiniz için aldınız. Toplantı e-postalarını Ayarlar › Bildirimler bölümünden kapatabilirsiniz.",
		zone:       "%s saati (GMT%s)",
		every:      "Her %s", everyN: "%d haftada bir %s", daily: "Her gün", dailyN: "%d günde bir",
		monthly: "Her ayın %d. günü", monthlyN: "%d ayda bir, ayın %d. günü", until: "%s, %s tarihine kadar", times: "%s, %d kez", and: " ve ",
	},
}

func mailLanguage(l string) string {
	if l == "tr" {
		return "tr"
	}
	return "en"
}

// zoneNames are zones people know by their country.
var zoneNames = map[string]map[string]string{
	"Europe/Istanbul": {"en": "Turkey", "tr": "Türkiye"},
}

// zoneName shows an IANA zone by its country or city ("Europe/Berlin" → "Berlin").
func zoneName(name, lang string) string {
	if n, ok := zoneNames[name][lang]; ok {
		return n
	}
	if i := strings.LastIndex(name, "/"); i >= 0 {
		name = name[i+1:]
	}
	return strings.ReplaceAll(name, "_", " ")
}

func gmt(t time.Time) string {
	_, off := t.Zone()
	sign := "+"
	if off < 0 {
		sign, off = "-", -off
	}
	if off%3600 == 0 {
		return fmt.Sprintf("%s%d", sign, off/3600)
	}
	return fmt.Sprintf("%s%d:%02d", sign, off/3600, off%3600/60)
}

func longDate(w mailWords, lang string, t time.Time) string {
	if lang == "tr" {
		return fmt.Sprintf("%d %s %s", t.Day(), w.months[t.Month()-1], w.weekdays[t.Weekday()])
	}
	return fmt.Sprintf("%s %d %s", w.weekdays[t.Weekday()], t.Day(), w.months[t.Month()-1])
}

func dayMonth(w mailWords, lang string, t time.Time) string {
	if lang == "tr" {
		return fmt.Sprintf("%d %s", t.Day(), w.months[t.Month()-1])
	}
	return fmt.Sprintf("%d %s", t.Day(), w.months[t.Month()-1])
}

// repeatText describes a repeat rule in the person's words and time zone.
func repeatText(w mailWords, lang, rule string, start time.Time, loc *time.Location) string {
	r, err := meetings.ParseRule(rule)
	if err != nil || r.Freq == "" {
		return ""
	}
	local := start.In(loc)
	var s string
	switch r.Freq {
	case "DAILY":
		s = w.daily
		if r.Interval > 1 {
			s = fmt.Sprintf(w.dailyN, r.Interval)
		}
	case "WEEKLY":
		days := r.ByDay
		if len(days) == 0 {
			days = []time.Weekday{start.Weekday()}
		}
		names := make([]string, 0, len(days))
		for _, d := range days {
			// The rule's days are in the meeting's zone; shown as such.
			n := w.weekdays[d]
			if lang == "tr" {
				n = strings.ToLower(n)
			}
			names = append(names, n)
		}
		list := strings.Join(names, ", ")
		if len(names) > 1 {
			list = strings.Join(names[:len(names)-1], ", ") + w.and + names[len(names)-1]
		}
		s = fmt.Sprintf(w.every, list)
		if r.Interval > 1 {
			s = fmt.Sprintf(w.everyN, r.Interval, list)
		}
	case "MONTHLY":
		s = fmt.Sprintf(w.monthly, local.Day())
		if r.Interval > 1 {
			s = fmt.Sprintf(w.monthlyN, r.Interval, local.Day())
		}
	}
	if r.Count > 0 {
		return fmt.Sprintf(w.times, s, r.Count)
	}
	return fmt.Sprintf(w.until, s, dayMonth(w, lang, r.Until.In(loc)))
}

// RenderMeetingMail writes the e-mail (with its calendar file).
func RenderMeetingMail(m MeetingMail, now time.Time) (Mail, error) {
	lang := mailLanguage(m.Language)
	w := words[lang]
	loc := location(m.RecipientTZ)
	if m.RecipientTZ == "" {
		loc = location(m.TimeZone)
	}
	start, end := m.Start.In(loc), m.End.In(loc)
	// The occurrence the e-mail is about: the first one still to come.
	if r, err := meetings.ParseRule(m.Rule); err == nil && r.Freq != "" {
		meetings.Occurrences(m.Start, location(m.TimeZone), r, m.Exdates, func(t time.Time) bool {
			start, end = t.In(loc), t.Add(m.End.Sub(m.Start)).In(loc)
			return t.Before(now)
		})
	}
	clock := func(a, b time.Time) string { return a.Format("15:04") + " – " + b.Format("15:04") }
	base := strings.TrimSuffix(m.PublicURL, "/")
	d := meetingMailData{
		Lang: lang, Workspace: m.Workspace, Title: m.Title,
		Cancelled: m.Kind == "cancel",
		Month:     w.monthsShort[start.Month()-1], Day: fmt.Sprint(start.Day()), Weekday: w.weekdays[start.Weekday()],
		Time: clock(start, end), Zone: fmt.Sprintf(w.zone, zoneName(loc.String(), lang), gmt(start)),
		LongDate:     longDate(w, lang, start),
		Repeat:       repeatText(w, lang, m.Rule, m.Start, location(m.TimeZone)),
		ChangedLabel: w.changed, WasLabel: w.was, CancelledLabel: w.cancelled,
		Button: w.open, ButtonURL: base + "/meetings/" + url.PathEscape(m.MeetingID),
		Footer: fmt.Sprintf(w.footer, m.Workspace), Host: hostOf(m.PublicURL),
	}
	when := longDate(w, lang, start) + " " + start.Format("15:04")
	method := "REQUEST"
	switch {
	case m.Kind == "invite":
		d.Lead, d.Subject = fmt.Sprintf(w.invite, m.Organizer), fmt.Sprintf(w.subjectInvite, m.Title, when)
		d.Hint, d.CalendarNote = w.hintInvite, w.calInvite
	case m.Kind == "update" && m.Skipped != nil:
		day := longDate(w, lang, m.Skipped.In(loc))
		d.Lead, d.Subject = fmt.Sprintf(w.skipped, m.Organizer, day), fmt.Sprintf(w.subjectSkipped, m.Title, dayMonth(w, lang, m.Skipped.In(loc)))
		d.Hint, d.CalendarNote = w.hintUpdate, w.calUpdate
	case m.Kind == "update" && m.WasStart != nil && m.WasEnd != nil:
		d.TimeChanged = true
		d.OldTime = clock(m.WasStart.In(loc), m.WasEnd.In(loc))
		if !sameDay(*m.WasStart, m.Start, loc) {
			d.OldTime = longDate(w, lang, m.WasStart.In(loc)) + " " + d.OldTime
		}
		d.Lead, d.Subject = fmt.Sprintf(w.moved, m.Organizer), fmt.Sprintf(w.subjectMoved, m.Title, when)
		d.Hint, d.CalendarNote = w.hintUpdate, w.calUpdate
	case m.Kind == "update":
		d.Lead, d.Subject = fmt.Sprintf(w.update, m.Organizer), fmt.Sprintf(w.subjectUpdate, m.Title)
		d.Hint, d.CalendarNote = w.hintUpdate, w.calUpdate
	default: // cancel
		method = "CANCEL"
		d.Lead = fmt.Sprintf(w.cancel, m.Organizer)
		if m.Removed {
			d.Lead = fmt.Sprintf(w.removed, m.Organizer)
		}
		d.Subject = fmt.Sprintf(w.subjectCancel, m.Title)
		d.Hint, d.CalendarNote = w.hintCancel, w.calCancel
		d.Button, d.ButtonURL = w.openChannel, base+"/c/"+url.PathEscape(m.ChannelID)
	}
	d.Preheader = d.Lead

	var where string
	switch m.PlaceKind {
	case "direct":
		where = w.callInDirect
	case "group":
		where = w.callInGroup
		if m.PlaceName != "" {
			where = fmt.Sprintf(w.callInNamedGroup, m.PlaceName)
		}
	default:
		where = fmt.Sprintf(w.callIn, m.PlaceName)
	}
	people := strings.Join(m.People, ", ")
	if len(m.People) > 3 || m.PeopleTotal > len(m.People) {
		shown := m.People
		if len(shown) > 3 {
			shown = shown[:3]
		}
		people = fmt.Sprintf(w.more, strings.Join(shown, ", "), max(m.PeopleTotal, len(m.People))-len(shown))
	}
	d.Rows = []mailRow{{w.where, []string{where}}, {w.host, []string{m.Organizer}}}
	if people != "" {
		d.Rows = append(d.Rows, mailRow{w.people, []string{people}})
	}
	if agenda := agendaLines(m.Agenda); len(agenda) > 0 && !d.Cancelled {
		d.Rows = append(d.Rows, mailRow{w.agenda, agenda})
	}

	var html, text bytes.Buffer
	if err := meetingHTML.Execute(&html, d); err != nil {
		return Mail{}, err
	}
	if err := meetingText.Execute(&text, d); err != nil {
		return Mail{}, err
	}
	ev := meetings.Event{
		UID: m.MeetingID + "@" + hostOf(m.PublicURL), Title: m.Title, Description: m.Agenda,
		Location: where, URL: base + "/meetings/" + url.PathEscape(m.MeetingID),
		Start: m.Start, End: m.End, TimeZone: m.TimeZone, Rule: m.Rule, Exdates: m.Exdates,
		Sequence: m.Sequence, Cancelled: m.Kind == "cancel",
		Attendees: []meetings.Person{{Name: m.RecipientName, Email: m.RecipientEmail}},
	}
	if addr := fromAddress(m.From); addr != "" {
		ev.Organizer = &meetings.Person{Name: m.Organizer, Email: addr}
	}
	name := "meeting.ics"
	if lang == "tr" {
		name = "toplanti.ics"
	}
	return Mail{
		To: m.RecipientEmail, ReplyTo: m.OrganizerEmail, Subject: d.Subject, Text: text.String(), HTML: html.String(),
		Calendar: meetings.Calendar(method, []meetings.Event{ev}, now), CalendarMethod: method, CalendarName: name,
		Inline: []InlineImage{{ID: "logo", Type: "image/png", Data: logoPNG}},
	}, nil
}

func sameDay(a, b time.Time, loc *time.Location) bool {
	a, b = a.In(loc), b.In(loc)
	return a.Year() == b.Year() && a.YearDay() == b.YearDay()
}

// agendaLines are the agenda's first lines (Markdown left as typed).
func agendaLines(s string) []string {
	var out []string
	for _, l := range strings.Split(strings.ReplaceAll(s, "\r\n", "\n"), "\n") {
		if l = strings.TrimSpace(l); l != "" {
			out = append(out, excerpt(l, 200))
		}
		if len(out) == 12 {
			break
		}
	}
	return out
}

func hostOf(public string) string {
	if u, err := url.Parse(public); err == nil && u.Host != "" {
		return u.Host
	}
	return "cenacle"
}

func fromAddress(from string) string {
	if a, err := mail.ParseAddress(from); err == nil {
		return a.Address
	}
	return ""
}
