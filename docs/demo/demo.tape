# Records the CLI's README demo. Re-record from the repository root with: vhs docs/demo/demo.tape
# It runs the published package from npm, in a throwaway folder.

Output docs/demo/demo.gif

Require npm
Require pnpm
Require git

Set Shell "bash"
Set FontSize 14
Set Width 1400
Set Height 760
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 60ms

Hide
Type "export PS1='$ ' npm_config_update_notifier=false npm_config_loglevel=silent GIT_AUTHOR_NAME=Demo GIT_AUTHOR_EMAIL=demo@example.com GIT_COMMITTER_NAME=Demo GIT_COMMITTER_EMAIL=demo@example.com"
Enter
Type "cd $(mktemp -d) && npm exec --yes create-ts-monorepo-starter@latest -- --help > /dev/null && clear"
Enter
Sleep 8s
Show

Type "npm create ts-monorepo-starter@latest"
Sleep 400ms
Enter
Wait+Screen /Project folder/
Sleep 800ms
Type "my-tools"
Sleep 500ms
Enter

# Pick our own scope and examples.
Wait+Screen /recommended setup/
Sleep 1s
Left
Sleep 600ms
Enter
Wait+Screen /npm scope/
Sleep 600ms
Ctrl+U
Type "@acme"
Sleep 500ms
Enter

# Keep lib and cli, drop web.
Wait+Screen /Which examples/
Sleep 1.2s
Down
Sleep 300ms
Down
Sleep 400ms
Space
Sleep 800ms
Enter
Wait+Screen /Initialize git/
Sleep 700ms
Enter
Wait+Screen /Install dependencies/
Sleep 700ms
Enter

# The install takes a while; skip most of it.
Sleep 3s
Hide
Wait+Screen@180s /Ready\./
Show
Sleep 1s
Screenshot docs/demo/demo.png
Sleep 6s
