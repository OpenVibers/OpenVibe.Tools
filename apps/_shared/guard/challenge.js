'use strict';
// ═══════════════════════════════════════════════════════════════
// The challenge hook (decision 4: Turnstile later, not now).
//
// A challenge provider decides whether a caller about to be refused for a quota may instead prove it
// is a person, and checks that proof. The guard asks it before a quota refusal of an anonymous or
// session caller; with the default (none) nobody is ever challenged and nothing changes.
//
//   {
//     name: 'turnstile',
//     required(req, caller, { reason, tool }) → boolean      challenge instead of refusing?
//     verify(req, caller) → Promise<boolean>                  the proof the request carries is good
//   }
//
// A request that passes verify() is let through once (its quota is still counted); one that needs a
// challenge and carries no good proof gets 403 problem tools.challenge.required, with the provider's
// name in `challenge` so the page knows which widget to show.
// ═══════════════════════════════════════════════════════════════

const NO_CHALLENGE = Object.freeze({
    name: 'none',
    required() { return false; },
    async verify() { return true; },
});

function validChallenge(c) {
    return !!c && typeof c.required === 'function' && typeof c.verify === 'function';
}

module.exports = { NO_CHALLENGE, validChallenge };
