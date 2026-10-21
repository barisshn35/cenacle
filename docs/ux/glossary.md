# Glossary

One concept, one word, everywhere: web, desktop, documentation and API messages. Texts are
managed as i18n keys; English is the default language, Turkish has equal quality.

| Concept              | English                         | Turkish                          | i18n key                                  | Notes                                     |
| -------------------- | ------------------------------- | -------------------------------- | ----------------------------------------- | ----------------------------------------- |
| Workspace            | Workspace                       | Çalışma alanı                    | `glossary.workspace`                      | Never "server" / "sunucu"                 |
| Channel              | Channel                         | Kanal                            | `glossary.channel`                        |                                           |
| Archive              | Archive / Unarchive             | Arşivle / Arşivden çıkar         | `glossary.archive`, `glossary.unarchive`  | Different from delete                     |
| Disable              | Disable / Enable                | Devre dışı bırak / Etkinleştir   | `glossary.disable`, `glossary.enable`     | Bots, webhooks, users                     |
| Delete               | Delete                          | Sil                              | `glossary.delete`                         | Only for permanent removal and messages   |
| Mute                 | Mute                            | Sessize al                       | `glossary.mute`                           | Stops notifications; unread stays visible |
| Rotate token         | Rotate token                    | Token'ı yenile                   | `glossary.rotateToken`                    | Never "reset" / "sıfırla"                 |
| Revoke token         | Revoke token                    | Token'ı iptal et                 | `glossary.revokeToken`                    |                                           |
| Mark as read         | Mark as read                    | Okundu olarak işaretle           | `glossary.markAsRead`                     |                                           |
| Cancel               | Cancel                          | Vazgeç                           | `glossary.cancel`, `ui:confirm.cancel`    | The safe choice in every dialog           |
| Undo                 | Undo                            | Geri al                          | `glossary.undo`, `ui:undo.action`         |                                           |
| Identity server      | Cenacle ID                      | Cenacle ID                       | —                                         | Product name of the IdP in the UI         |
| Sign in              | Sign in / Sign out              | Giriş yap / Çıkış yap            | `auth.signOut`                            | Never "log in" / "oturum aç"              |
| Session              | Session                         | Oturum                           | —                                         | "Your session has ended"                  |
| Announcement channel | Announcement channel            | Duyuru kanalı                    | `channels.kinds.announcement`             | Only the administrator posts              |
| Join / Leave         | Join / Leave channel            | Katıl / Kanaldan ayrıl           | `channels.join`, `channels.leave`         | Leaving shows "Undo", no confirmation     |
| Visibility           | Public / Private                | Herkese açık / Özel              | `channels.visibility.*`                   | Private channels show a lock              |
| Channel manager      | Manager                         | Yönetici                         | `channels.manager`                        | Adds and removes people                   |
| Workspace roles      | Owner / Admin / Member          | Sahip / Yönetici / Üye           | `workspaces.roles.*`                      | "Admin" here is a workspace role          |
| Invitation           | Invite people / Invitation link | Kişi davet et / Davet bağlantısı | `workspaces.invitePeople`, `invites.link` | Links expire and can be revoked           |

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
