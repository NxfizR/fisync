> **Status: optional, not set up.** fisync works without a certificate. Windows will show an "unknown publisher" warning on the installer until you sign it. Newer certificates usually can't be exported as a `.pfx` file, so check with your provider whether they support signing from GitHub Actions before you buy.

# Signing the Windows installer

Unsigned installers work, but Windows shows a warning ("Windows protected your PC") until the program has a good reputation. A code-signing certificate removes most of that.

## Get a certificate

Buy a code-signing certificate from a certificate authority (for example Sectigo, DigiCert or SSL.com). Standard (OV) certificates are cheaper; EV certificates build reputation faster. Some providers now keep the key on a hardware token or in a cloud service. If so, the signing steps below need changing, so check with the provider.

## Add it to GitHub

1. Export the certificate as a `.pfx` file with a password.
2. Convert it to text in PowerShell:

       [Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\path\to\certificate.pfx")) | Set-Clipboard

3. On github.com open the repository → Settings → Secrets and variables → Actions → New repository secret. Add:
   - `CSC_LINK`: the text on your clipboard
   - `CSC_KEY_PASSWORD`: the password you chose

The release workflow picks these up automatically. Linux builds are not signed this way.

## Keep it safe

Store the `.pfx` file and its password somewhere private, such as a password manager. Losing it means you must buy a new certificate and new installers will show the warning until reputation builds again.
