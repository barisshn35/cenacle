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
| Sign in              | Sign in / Sign out              | Giriş yap / Çıkış yap                 | `auth.continue`, `auth.signOut`           | Never "log in" / "oturum aç"                  |
| Session              | Session                         | Oturum                                | —                                         | "Your session has ended"                      |
| Announcement channel | Announcement channel            | Duyuru kanalı                         | `channels.kinds.announcement`             | Only admins post                              |
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
| Rotate (bot token)   | Rotate                          | Yenile                                | `bots.rotate`                             | New token; the old one works for an overlap   |
| Directory groups     | Directory groups                | Dizin grupları                        | `groups.title`                            | Groups of Cenacle ID (directory or provider)  |
| Guest                | Guest                           | Misafir                               | `workspaces.roles.guest`                  | Sees only their channels and their people     |
| Passkey              | Passkey                         | Geçiş anahtarı                        | —                                         | Cenacle ID pages; never "security key" alone  |
| Identity provider    | Identity provider               | Kimlik sağlayıcısı                    | —                                         | OIDC or SAML; "Continue with …"               |
| Directory            | Directory                       | Dizin                                 | —                                         | Active Directory or LDAP                      |
| Profile              | Edit profile                    | Profili düzenle                       | `profile.edit`                            | Picture, @username, time zone, last seen      |
| Custom status        | Custom status                   | Özel durum                            | `profile.statusSet`                       | Emoji and/or text; clears itself              |
| Username             | Username                        | Kullanıcı adı                         | `profile.username`                        | Shown as @username                            |
| Last seen            | last seen                       | son görülme                           | `profile.lastSeen`                        | Only while offline; can be hidden             |
| Appearance           | Appearance                      | Görünüm                               | `settings.tabs.appearance`                | Theme, fonts, code blocks                     |
| Mute a channel       | Mute / Unmute                   | Sessize al / Sesini aç                | `notifications.muteChannel`               | Until a time or until unmuted                 |
| Pause notifications  | Pause notifications             | Bildirimleri duraklat                 | `notifications.pause`                     | All notifications, for a while                |
| Quiet hours          | Quiet hours                     | Sessiz saatler                        | `notifications.quietHours`                | Daily, in one's own time zone                 |
| Forum                | Forum                           | Forum                                 | `channels.kinds.forum`                    | Posts with titles, answered in threads        |
| Poll                 | Poll                            | Anket                                 | `community.poll.legend`                   | 2–10 options                                  |
| Time out             | Time out                        | Sustur                                | `community.moderation.timeout`            | No messages for a while (moderators)          |
| Slow mode            | Slow mode                       | Yavaş mod                             | `community.moderation.slowMode`           | Wait between messages                         |
| Report               | Report                          | Şikâyet et                            | `community.report.action`                 | To the workspace's moderators                 |
| Playbook             | Playbook                        | Playbook                              | `home.playbooks`                          | Repeatable checklists                         |
| Thread               | Thread                          | Yanıt dizisi                          | `threads.title`                           | One level of replies to a message             |
| Pin                  | Pin / Unpin                     | Sabitle / Sabitlemeyi kaldır          | `pins.pin`                                | Up to 50 per channel                          |
| Save for later       | Save for later                  | Sonrası için kaydet                   | `saved.save`                              | Personal; reminder optional                   |
| Search               | Search                          | Ara                                   | `search.title`                            | Messages and files                            |
| Forward              | Forward                         | İlet                                  | `richer.forward.action`                   | A copy, with where it came from               |
| Copy link            | Copy link                       | Bağlantıyı kopyala                    | `richer.link.copy`                        | Permalink to a message                        |
| Burn after reading   | Burn after reading              | Okununca sil                          | `richer.burn.choice`                      | Conversations only; read once, for a time     |
| Voice message        | Record a voice message          | Sesli mesaj kaydet                    | `richer.record.voice`                     | Recorded in the app, with a waveform          |
| Custom emoji         | Custom emoji                    | Özel emojiler                         | `richer.manage.emoji.title`               | `:name:` in text and reactions                |
| Sticker              | Stickers                        | Çıkartmalar                           | `richer.stickers.title`                   | A picture sent as a message of its own        |
| Sticker pack         | Sticker packs                   | Çıkartma paketleri                    | `richer.manage.packs.title`               | Stickers added together, under one name       |
| Workflow             | Workflow                        | İş akışı                              | `automation.admin.workflows`              | A trigger and steps, without code             |
| Form                 | Form                            | Form                                  | `automation.admin.forms`                  | Same questions every time                     |
| Approve / Reject     | Approve / Reject                | Onayla / Reddet                       | `automation.card.approve`                 | One of the approvers decides                  |
| Tab                  | Tab                             | Sekme                                 | `collab.tabs.label`                       | A canvas, list or link of a channel           |
| Canvas               | Canvas                          | Tuval                                 | `collab.tabs.newCanvas`                   | A page of Markdown; one editor at a time      |
| List / Board         | List / Board                    | Liste / Pano                          | `collab.list.board`                       | A board is a list grouped by a column         |
| Tasks                | Tasks                           | Görevler                              | `home.tasks`                              | Approvals, forms and rows assigned to me      |
| Retention            | Retention                       | Saklama süresi                        | `compliance.retention.title`              | Days messages are kept, then deleted for good |
| Legal hold           | Legal hold / Release            | Yasal saklama / Kaldır                | `compliance.holds.title`                  | Keeps messages from every deletion            |
| Classification       | Classification                  | Sınıflandırma                         | `compliance.classes.title`                | A channel's banner                            |
| Encrypted channel    | Encrypted end to end            | Uçtan uca şifreli                     | `e2e.info`                                | Readable only on members' devices             |
| AI                   | AI / Written by AI              | Yapay zekâ / Yapay zekâ yazdı         | `ai.written`                              | Off unless operator and workspace allow it    |
| Federation           | Connected server / Share        | Bağlı sunucu / Paylaş                 | `federation.connections.title`            | Channels shared with another Cenacle          |
| Interface texts      | Interface texts                 | Arayüz metinleri                      | `settings.tabs.texts`                     | Administrators replace a few texts            |

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

## Turkish register

Turkish interface text addresses the reader formally, as "siz". Sentences, descriptions,
hints, placeholders, errors, confirmations and empty states use second person plural forms
(imperatives, possessives, pronouns and verbs). Buttons, menu items, tab names and other short
command labels stay bare imperatives: "Kaydet", "Gönder", "Sil", "Sonra gönder".

| Informal (do not use)                | Formal                                    |
| ------------------------------------ | ----------------------------------------- |
| Bağlantını kontrol edip tekrar dene. | Bağlantınızı kontrol edip tekrar deneyin. |
| Bu kanalın üyesi değilsin.           | Bu kanalın üyesi değilsiniz.              |
| Hesabın yok mu? Yöneticinden iste.   | Hesabınız yok mu? Yöneticinizden isteyin. |
| Bunu yalnızca sen görüyorsun         | Bunu yalnızca siz görüyorsunuz            |

Third-person text that does not address the reader stays as it is ("Herkes bu kanalın
üyesi."). Do not add "Lütfen" where the English has no "please".

`web/src/i18n/i18n.test.ts` checks that English and Turkish resources have the same keys,
that glossary terms match this table and that forbidden wording ("reset"/"sıfırla",
"OK"/"Yes"/"Tamam"/"Evet" as labels) does not appear.
