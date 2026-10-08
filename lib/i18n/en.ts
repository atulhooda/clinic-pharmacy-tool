/**
 * English strings for the sign-in screens. Hindi and Gujarati arrive with the UI kit in PR 4,
 * reviewed by a native speaker before use (06a §16: every string in en/hi/gu, Latin digits).
 */
export const en = {
  appName: 'Clinic Pharmacy',
  signIn: {
    title: 'Sign in',
    login: 'Login',
    password: 'Password',
    submit: 'Sign in',
    working: 'Signing in…',
    wrong: 'Wrong login or password. After 5 wrong tries, password sign-in pauses for 15 minutes.',
    tooMany: 'Too many attempts from this network. Try again in a few minutes.',
    unavailable: 'The pharmacy is not available right now. Try again shortly.',
    failed: 'Sign-in failed. Try again.',
  },
  home: {
    signedInAs: 'Signed in as',
    at: 'at',
    premises: 'Your premises',
    noPremises: 'You are not assigned to any premises yet. Ask the owner.',
    signOut: 'Sign out',
    notSignedIn: 'Open your clinic’s sign-in link to sign in. It looks like this:',
    linkShape: '/your-clinic/sign-in',
    changePassword: 'Change password',
  },
  password: {
    title: 'Change your password',
    mustChange: 'You signed in with a one-time password. Choose your own password to continue.',
    current: 'Current password',
    next: 'New password',
    confirm: 'New password again',
    rules: 'At least 8 characters. Not your login or name, and not a common password.',
    mismatch: 'The two new passwords are different.',
    submit: 'Change password',
    done: 'Password changed.',
    wrongCurrent: 'The current password is wrong.',
    policy: 'The new password does not meet the rules.',
    ended: 'Too many wrong passwords. Sign in again.',
  },
} as const;
