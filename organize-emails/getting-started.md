# Email Organizer: getting started (test group)

A local app that flags the emails in your Gmail that deserve your attention. The AI model runs on your own computer, so your mail is never sent anywhere.

## You need

- A Mac, Windows or Linux computer with about 16 GB of memory (the model is 7.7 GB)
- [Node.js](https://nodejs.org) 22.18 or newer
- [Ollama](https://ollama.com/download), installed and open
- A Gmail account
- Two things from the project owner:
  1. Your Gmail address added as a **test user** (Google blocks anyone not on the list)
  2. The `client_secret_….json` file

## Start it

```bash
git clone <repo-url>
cd <repo>/organize-emails
npm install
```

Put the `client_secret_….json` file in the `secrets/` folder, then:

```bash
npm start
```

The first run downloads the model (several GB, once). When it says **Ready**, your browser opens the app. Leave the terminal window open while you use it.

## Using it

1. **Connect Gmail.** Read-only: the app can't send, delete or change anything. Google will warn that the app is unverified; choose *Advanced*, then continue.
2. **Personalize.** It shows who writes to you most, and you say which senders matter. Add a line about what's going on in your life.
3. **Check your recent mail.** Classifies the last 3 days. Expect about 15 seconds per email, so a first run of 100 emails takes a while.
4. **Train.** Rate the results as important or not. Your corrections make it better for you.

## Good to know

- Your mail, ratings and settings are stored in your own app-data folder, not inside the cloned folder, so updating with `git pull` never touches them:
  - Mac: `~/Library/Application Support/Email Organizer`
  - Windows: `%APPDATA%\Email Organizer`
  - Linux: `~/.local/share/email-organizer`
- While the app is in testing, Google **signs you out every 7 days**. Just press *Sign in with Gmail* again.
- To remove everything: delete that folder, and remove the app at https://myaccount.google.com/permissions
