# Publishing on Google Play: what to check first

This is a summary of the issues that matter for fisync, not legal advice. Google changes its policies often, so read the current text before you submit anything:
https://play.google.com/about/developer-content-policy/

## Likely problems

- **Text messages and call log.** Google restricts apps that read or send texts and read the call log. Only apps that are the default SMS or phone app, or that have a clear core purpose that needs them, are normally allowed. fisync's purpose (controlling your own computer) needs a justification and a declaration form. Expect review questions.
- **Notification access.** Apps that read notifications must explain the purpose and show it clearly. The notification listener is the feature most likely to be questioned.
- **Background service.** Long-running foreground services must declare their type and purpose.
- **Privacy policy.** Required, and it must match what the app does (see PRIVACY.md). Host it at a public address.
- **Data safety form.** You must describe every kind of data the app handles, and whether it leaves the phone. fisync sends it only to your own computer, which should be stated plainly.

## Options

1. **Publish on Google Play** with a declaration for the restricted permissions. Possible, but the review can take weeks and may be refused.
2. **Keep distributing the APK on GitHub** (what you do now). No store review, but users must allow installs from unknown sources, and Android shows a warning.
3. **Another store** such as F-Droid, which has its own rules and suits open-source apps. It builds the app from source, so the build must be reproducible.

Whichever you choose, keep the privacy policy and the permission explanations accurate, because they are what reviewers read first.
