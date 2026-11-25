# A project can change or turn off its crewmate disclosure

From the captain's reply on the change that opens a fork review's story comment with a line saying an Infinitary crewmate wrote it: the line is on by default, and each project can turn it off or write its own.
`app_change project-settings` gains `contributorDisclosure`: the line opening what the crew posts to an outside contributor, an empty string to post none, or null to restore the default.
The project's current line reads as `contributorDisclosure` in its settings value, null when it uses the default.
The captain makes the same change with Settings → Projects' Say a crewmate wrote it.
The words live in the project-settings action line, its one home; the fixed part grows by about 25 tokens by the app's count.
