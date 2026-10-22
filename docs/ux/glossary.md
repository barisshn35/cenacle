# Glossary

One concept, one word, everywhere: web, desktop, documentation and API messages. Texts are
managed as i18n keys; English is the default language, Turkish has equal quality.

| Concept              | English                         | Turkish                               | i18n key                                  | Notes                                         |
| -------------------- | ------------------------------- | ------------------------------------- | ----------------------------------------- | --------------------------------------------- |
| Workspace            | Workspace                       | Çalışma alanı                         | `glossary.workspace`                      | Never "server" / "sunucu"                     |
| Channel              | Channel                         | Kanal                                 | `glossary.channel`                        |                                               |
| Archive              | Archive / Unarchive             | Arşivle / Arşivden çıkar              | `glossary.archive`, `glossary.unarchive`  | Different from delete                         |
| Disable              | Disable / Enable                | Devre dışı bırak / Etkinleştir        | `glossary.disable`, `glossary.enable`     | Bots, webhooks, users                         |
| Delete               | Delete                          | Sil                                   | `glossary.delete`                         | Only for permanent removal and messages       |
| Mute                 | Mute                            | Sessize al                            | `glossary.mute`                           | Stops notifications; unread stays visible     |
| Rotate token         | Rotate token                    | Token'ı yenile                        | `glossary.rotateToken`                    | Never "reset" / "sıfırla"                     |
| Revoke token         | Revoke token                    | Token'ı iptal et                      | `glossary.revokeToken`                    |                                               |
| Mark as read         | Mark as read                    | Okundu olarak işaretle                | `glossary.markAsRead`                     |                                               |
| Cancel               | Cancel                          | Vazgeç                                | `glossary.cancel`, `ui:confirm.cancel`    | The safe choice in every dialog               |
| Undo                 | Undo                            | Geri al                               | `glossary.undo`, `ui:undo.action`         |                                               |
| Identity server      | Cenacle ID                      | Cenacle ID                            | —                                         | Product name of the IdP in the UI             |
| Sign in              | Sign in / Sign out              | Giriş yap / Çıkış yap                 | `auth.signOut`                            | Never "log in" / "oturum aç"                  |
| Session              | Session                         | Oturum                                | —                                         | "Your session has ended"                      |
| Announcement channel | Announcement channel            | Duyuru kanalı                         | `channels.kinds.announcement`             | Only the administrator posts                  |
| Join / Leave         | Join / Leave channel            | Katıl / Kanaldan ayrıl                | `channels.join`, `channels.leave`         | Leaving shows "Undo", no confirmation         |
| Visibility           | Public / Private                | Herkese açık / Özel                   | `channels.visibility.*`                   | Private channels show a lock                  |
| Channel manager      | Manager                         | Yönetici                              | `channels.manager`                        | Adds and removes people                       |
| Workspace roles      | Owner / Admin / Member          | Sahip / Yönetici / Üye                | `workspaces.roles.*`                      | "Admin" here is a workspace role              |
| Invitation           | Invite people / Invitation link | Kişi davet et / Davet bağlantısı      | `workspaces.invitePeople`, `invites.link` | Links expire and can be revoked               |
| Direct messages      | Direct messages                 | Doğrudan mesajlar                     | `dm.title`                                | Direct (2 people) and group conversations     |
| Conversation         | Direct / Group conversation     | Birebir / Grup konuşması              | `channels.kinds.direct`, `.group`         | Same people, same conversation                |
| Status (presence)    | Online / Away / Do not disturb  | Çevrimiçi / Uzakta / Rahatsız etmeyin | `shell.presence.*`                        | Offline: Çevrimdışı; color and shape          |
| New messages         | New messages                    | Yeni mesajlar                         | `chat.newMessages`                        | The line above the first unread message       |
| Mention              | Mention                         | Bahsetme                              | `mentions.*`                              | "@Name"; a number badge on the channel        |
| Reaction             | Reaction / Add reaction         | Tepki / Tepki ekle                    | `reactions.*`                             | One emoji; pressing again takes it back       |
| Bot / Integrations   | Bot / Integrations              | Bot / Entegrasyonlar                  | `bots.*`                                  | Bots never sign in; a "Bot" badge             |
| Incoming webhook     | Incoming webhook                | Gelen webhook                         | `bots.webhooks`                           | A secret address; shown once                  |
| Slash command        | Command                         | Komut                                 | `commands.*`, `bots.commands`             | Typed as `/name`; answers may be only for you |
| Event subscription   | Events / Deliveries             | Olaylar / Teslimatlar                 | `bots.events`, `bots.deliveries`          | Signed POSTs to a bot; retried                |
| Send later           | Send later / Scheduled          | Sonra gönder / Zamanlanmış            | `scheduled.*`                             | Cancel until it goes out; reminders too       |
| Rotate token         | Rotate                          | Yenile                                | `bots.rotate`                             | New token; the old one works for an overlap   |
| Directory groups     | Directory groups                | Dizin grupları                        | `groups.title`                            | Groups of Cenacle ID (directory or provider)  |
| Guest                | Guest                           | Misafir                               | `workspaces.roles.guest`                  | Sees only their channels and their people     |
| Passkey              | Passkey                         | Geçiş anahtarı                        | —                                         | Cenacle ID pages; never "security key" alone  |
| Identity provider    | Identity provider               | Kimlik sağlayıcısı                    | —                                         | OIDC or SAML; "Continue with …"               |
| Directory            | Directory                       | Dizin                                 | —                                         | Active Directory or LDAP                      |
| Profile              | Edit profile                    | Profili düzenle                       | `profile.edit`                            | Picture, @username, time zone, last seen      |
| Custom status        | Custom status                   | Özel durum                            | `profile.statusSet`                       | Emoji and/or text; clears itself              |
| Username             | Username                        | Kullanıcı adı                         | `profile.username`                        | Shown as @username                            |
| Last seen            | last seen                       | son görülme                           | `profile.lastSeen`                        | Only while offline; can be hidden             |

## Rules

1. **Buttons name the action with a verb:** "Archive channel", "Rotate token". Never "OK",
   "Yes", "Tamam" or "Evet".
2. **The cancel button is "Cancel" / "Vazgeç"** and holds the default focus in
   confirmation dialogs.
3. **Confirmation texts say three things:** what will happen, who is affected, and whether
   and how it can be undone.
4. **Errors have four parts:** what happened, why (if known), what the user can do, and the
   error code / request ID. No blame, jargon or stack traces.
5. **Badges keep their meaning:** a number means mentions or direct messages; unread
   without mentions is bold text and a dot.
6. **Channel names are shown as they are,** without a "#" before them; an icon tells the
   kind of channel.
7. **Color is never the only signal:** destructive actions use color, icon and text;
   presence uses color and shape.

`web/src/i18n/i18n.test.ts` checks that English and Turkish resources have the same keys,
that glossary terms match this table and that forbidden wording ("reset"/"sıfırla",
"OK"/"Yes"/"Tamam"/"Evet" as labels) does not appear.
