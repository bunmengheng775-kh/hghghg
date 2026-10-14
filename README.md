# Study Hub

## Run on your PC (no npm commands)
Install and start Docker Desktop. In PowerShell, go to this project folder and build the app:

    docker build -t study-hub .

Set the initial Owner password securely, then start the server with a persistent data volume:

    $securePassword = Read-Host "Choose an initial Owner password" -AsSecureString
    $env:INITIAL_OWNER_PASSWORD = (New-Object System.Net.NetworkCredential('', $securePassword)).Password
    docker run -d --name study-hub -p 3000:3000 -v study-hub-data:/data -e "INITIAL_OWNER_PASSWORD=$env:INITIAL_OWNER_PASSWORD" study-hub
    Remove-Item Env:INITIAL_OWNER_PASSWORD
    Remove-Variable securePassword

Open `http://localhost:3000` on your PC. The first account is the Owner (default username
`heng`); passwords are stored as hashes. Keep the `study-hub-data` Docker volume to preserve
accounts, file records, and uploads when updating or recreating the container.
Opening `public/index.html` or using VS Code Live Server can display the page, but does not run
the Study Hub server. On a local file or private Wi-Fi address, if the server is unavailable,
login falls back to a browser-only demo. Demo accounts and roles are not verified, passwords
are not saved, and data is not shared with other devices. The online HTTPS app does not use
this demo fallback.

## Accounts and permissions
Choose the role assigned to your account on the login screen. Sign in as `heng` (Owner) and use
**Manage users** to create accounts, change access, or delete accounts. The selected role must
match the account; choosing Owner does not grant Owner permissions.
Students can view materials; Teachers can upload, rename, caption, and delete materials.
Only the Owner can manage accounts. The owner role is reserved for the existing `heng` account,
which cannot be deleted in the user manager.

On the local Express server, account records and password hashes are saved in
`DATA_DIR/data/users.json`; passwords are never stored as plain text. Vercel uses Neon for
accounts and sessions, and private Vercel Blob storage for uploaded files. The browser-only demo
does not save or verify accounts or passwords and cannot share them with other devices.

## Open it on your phone
Connect your phone and PC to the same Wi-Fi network. On your PC, run `ipconfig` and find its
IPv4 address, then open `http://<PC-IPv4-address>:3000` in your phone's browser (for example,
`http://192.168.1.23:3000`). Do not use `localhost` on your phone; that points to the phone
itself. If Windows Firewall asks, allow Docker Desktop on your private network.

Tap **Add to Home Screen** in Study Hub to install the shortcut. On iPhone/iPad, use Safari's
Share button and choose **Add to Home Screen**. The app shell can open offline, but signing in
and loading materials still requires a connection to the PC.

## Deploy on Render (alternative)
For access from outside your home Wi-Fi, you can deploy the Express server to Render. The
included Render Blueprint uses a persistent disk, so user accounts, uploaded files, and file records are shared between
devices and survive deploys. Render installs dependencies during deployment; you do not need to
run `npm install` on your PC.

1. Push this project to a GitHub repository.
2. In Render, choose **New > Blueprint** and select that repository; Render reads `render.yaml`.
3. Set `INITIAL_OWNER_PASSWORD` privately in the service's Environment settings before its first
   deploy. Keep the password out of Git.
4. After Render creates the service, set `PUBLIC_URL` to its HTTPS address and redeploy.
5. Open that same HTTPS address on every phone or PC. Teachers' uploads appear in other users'
   materials list automatically within about eight seconds.

The Blueprint uses a paid Render plan because persistent disks require one. Do not remove or
replace the disk after users have started uploading files.

## Deploy to Vercel
Vercel serves the website and runs its API as serverless functions. Neon stores accounts,
sessions, exercises, and submissions; a private Vercel Blob store keeps teacher uploads. Vercel
installs the server dependencies during deployment, so no npm command is needed on your PC.

1. Push the project to GitHub. The repository root should contain `.vercelignore`, `vercel.json`,
   `package.json`, `schema.sql`, `api/`, and the website files. If using the flat repository
   layout, copy
   `public/index.html` to root `index.html`, `public/js/api.js` to root `api.js`,
   `public/js/app.js` to root `app.js`, `public/css/style.css` to root `style.css`,
   `public/sw.js` to root `sw.js`, `public/manifest.webmanifest` to root
   `manifest.webmanifest`, and both icon PNGs to the root. Keep `api/[...route].js` in the
   `api/` folder, and copy the updated `package.json` and `vercel.json` from this project.
2. In Vercel, import the GitHub repository. Leave **Root Directory** blank when the files above
   are at the repository root; no build command or output directory is needed.
3. Create a Neon Postgres database. In its SQL editor, run the contents of `schema.sql`.
4. Create a **private** Vercel Blob store and connect it to this Vercel project. Add Neon’s
   `DATABASE_URL` to the Vercel project environment if the Neon integration did not add it.
   The connected Blob store supplies the Blob credentials.
5. In Vercel project **Settings > Environment Variables**, set `INITIAL_OWNER_PASSWORD` to a
   private password of 8–128 characters. Optionally set `INITIAL_OWNER_USERNAME` (defaults to
   `heng`) and `INITIAL_OWNER_NAME` (defaults to `Heng`). Add `API_KEY` only if another app
   needs the public file-list API or if `WEBHOOK_URL` is enabled. Keep these values out of Git.
6. Deploy and check `https://YOUR-VERCEL-DOMAIN/api/health`; it should return `{"ok":true}`.
   Sign in as `heng` with the initial password, then use **Manage users** to create teacher and
   student accounts. Use the same Vercel URL on every device to share materials and exercises.

Files are limited to 4 MB each on this Vercel API (Vercel limits a function request to 4.5 MB).
The upload UI sends each selected file separately. Blob files are private and are delivered
through the authenticated Study Hub API.
This creates a new data store; existing accounts and uploads from Cloudflare or Render are not
automatically copied to Neon or Blob.

Teachers can create worksheets with written-answer questions. Students submit answers in Study
Hub, and teachers can review submissions. Teachers can upload files and photos as course
materials; account passwords are stored as salted hashes in Neon.

## Folders
- public/css/style.css   all styling
- public/js/api.js       calls to the server
- public/js/app.js       screens (login, list, viewer)
- api/[...route].js      Vercel serverless API
- schema.sql             Neon Postgres tables
- data/users.json        local persistent user accounts (excluded from Git)
- data/files.json        uploaded file records
- data/exercises.json    worksheet questions
- data/submissions.json  student exercise answers
- uploads/               the uploaded files
- server.js              login + upload + public API + webhook

## Let other drives / apps see uploads
1. Pull list (any app):
   curl -H "x-api-key: YOUR_KEY" http://localhost:3000/api/public/files
   Each item has a `url` to download the file.
2. Push (instant): set WEBHOOK_URL. On every upload/rename/delete the server POSTs
   {"event":"uploaded|updated|deleted","file":{id,name,caption,kind,size,url},"at":"..."}
   Connect it to Zapier / Make / n8n / Google Apps Script -> Google Drive, OneDrive, Dropbox "Upload file from URL".
