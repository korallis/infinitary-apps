# A project's line saying a crewmate wrote it

Adds an optional `contributorDisclosure` field to a project (`RepoView`): the project's own line opening what the crew posts to an outside contributor, or an empty string for none; absent, the default line.
`inf:repos:configure` takes an optional `contributorDisclosure`: the project's own line, an empty string to post none, or null to go back to the default line.
A home without the change sends no `contributorDisclosure`, so a view shows the default line, which that home posts.
A home without the change reads the patch strictly, so it refuses a view's `contributorDisclosure` with its reason and changes nothing.
A view without the change ignores `contributorDisclosure`.
