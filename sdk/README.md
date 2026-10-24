# Cenacle bot SDKs

Libraries for bots that talk to Cenacle from their own process: a client for the API (with
a bot token, `cnb_…`) and handlers for what Cenacle sends to bots — slash commands,
interactions (buttons, menus, dialogs) and event subscriptions — with the signature
checked. They use only their language's standard library. The protocol they wrap is in
[docs/integrations](../docs/integrations/README.md).

Unlike the server (AGPL-3.0), the SDKs are under the **Apache License 2.0** ([LICENSE](LICENSE)),
so bots of any license can use them.

## Go

```sh
go get github.com/barisshn35/cenacle/sdk/go
```

```go
import cenacle "github.com/barisshn35/cenacle/sdk/go"

client := &cenacle.Client{BaseURL: "https://chat.example.com", Token: os.Getenv("CENACLE_TOKEN")}

http.Handle("/interaction", cenacle.InteractionHandler(os.Getenv("CENACLE_SECRET"),
	func(ctx context.Context, in cenacle.Interaction) (cenacle.InteractionResponse, error) {
		if in.Type == "action" && in.ActionID == "approve" {
			text := "Approved by " + in.User.Name
			return cenacle.InteractionResponse{Update: &cenacle.Update{Text: &text}}, nil
		}
		return cenacle.InteractionResponse{}, nil
	}))

_, err := client.PostMessage(ctx, channelID, cenacle.Post{
	Attachments: []cenacle.Attachment{{
		Title:   "Release 1.4",
		Actions: []cenacle.Action{{ID: "approve", Type: "button", Text: "Approve", Style: "primary"}},
	}},
})
```

`CommandHandler` and `EventHandler` work the same way; `Verify` and `Sign` check and
make signatures.

## Python

```sh
pip install ./sdk/python
```

```python
import os
from wsgiref.simple_server import make_server
import cenacle_bot

client = cenacle_bot.Client("https://chat.example.com", os.environ["CENACLE_TOKEN"])

def on_interaction(req):
    if req["type"] == "action" and req["action_id"] == "approve":
        return {"update": {"text": "Approved by " + req["user"]["name"]}}
    if req["type"] == "dialog_submission" and not req["values"].get("reason"):
        return {"errors": {"reason": "Say why."}}
    return {}

app = cenacle_bot.app(os.environ["CENACLE_SECRET"], on_interaction=on_interaction)
make_server("", 8080, app).serve_forever()  # POST /command, /interaction, /event
```

Any WSGI server (gunicorn, uWSGI) can serve `app` behind TLS.
