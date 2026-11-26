# An account row may say when a share was last read

A quota account row built from sessions' readings may carry `lastShareAt`, when a session last reported a share of the allowance.
A reader that names when a row with no share in its windows was last read takes that time and no other; without it, it names none.
An older side ignores the field.
