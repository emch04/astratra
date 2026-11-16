const { createRouteGuard } = require('../src');

const guard = () => createRouteGuard({
  publicSegments: ['home', 'login', 'forgot-password', 'reset-password', 'onboarding']
});

describe('what is public', () => {
  test('the named segments are reachable without a session', () => {
    for (const route of [['home'], ['login'], ['reset-password', 'abc123']]) {
      expect(guard().isPublicRoute(route)).toBe(true);
    }
  });

  test('EVERYTHING else is closed — a screen added later ships closed, not open', () => {
    /* A list of protected screens fails the other way: every screen forgotten
       on the list ships open, silently. */
    for (const route of [['dashboard'], ['students', 's1'], ['brand-new-screen']]) {
      expect(guard().isPublicRoute(route)).toBe(false);
    }
  });

  test('a path string works as well as segments', () => {
    expect(guard().isPublicRoute('/login')).toBe(true);
    expect(guard().isPublicRoute('/students/s1')).toBe(false);
  });

  test('the bare root is public by default — the splash decides for itself', () => {
    expect(guard().isPublicRoute([])).toBe(true);
    expect(guard().isPublicRoute('/')).toBe(true);
    expect(guard().isPublicRoute(null)).toBe(true);
  });

  test('a product can close the bare root instead', () => {
    const strict = createRouteGuard({ publicSegments: ['login'], emptyIsPublic: false });

    expect(strict.isPublicRoute([])).toBe(false);
  });
});

describe('the redirect decision', () => {
  test('a signed-out user on a protected screen goes to login', () => {
    expect(guard().shouldRedirectToLogin({ isLoading: false, isAuthenticated: false, route: ['dashboard'] })).toBe(true);
  });

  test('a signed-in user is never redirected', () => {
    expect(guard().shouldRedirectToLogin({ isLoading: false, isAuthenticated: true, route: ['dashboard'] })).toBe(false);
  });

  test('a signed-out user on a public screen stays', () => {
    expect(guard().shouldRedirectToLogin({ isLoading: false, isAuthenticated: false, route: ['home'] })).toBe(false);
  });

  test('WHILE THE SESSION RESTORES, nothing is decided', () => {
    /* At startup "authenticated" is false before it becomes true; redirecting
       on that transient state ejects a signed-in user on every cold start. */
    expect(guard().shouldRedirectToLogin({ isLoading: true, isAuthenticated: false, route: ['dashboard'] })).toBe(false);
  });

  test('the login route is exposed for the navigation to use', () => {
    expect(guard().loginRoute).toBe('/login');
    expect(createRouteGuard({ publicSegments: ['x'], loginRoute: '/signin' }).loginRoute).toBe('/signin');
  });
});

describe('wiring', () => {
  test('a guard with no public list is refused — that is the design decision', () => {
    expect(() => createRouteGuard({})).toThrow(/publicSegments/);
    expect(() => createRouteGuard({ publicSegments: [] })).toThrow(/publicSegments/);
  });
});

describe('what stays closed', () => {
  test('a path that climbs out of a public segment is closed', () => {
    for (const route of ['home/../dashboard', '/login/../../students/s1', ['home', '..', 'dashboard'], './home/../admin']) {
      expect(guard().isPublicRoute(route)).toBe(false);
      expect(guard().shouldRedirectToLogin({ isLoading: false, isAuthenticated: false, route })).toBe(true);
    }
    /* Climbing back INTO a public segment stays public. */
    expect(guard().isPublicRoute('dashboard/../login')).toBe(true);
  });

  test('segments are matched exactly: case and look-alikes do not open anything', () => {
    for (const route of [['Home'], ['LOGIN'], ['login-admin'], ['home2'], [' home']]) {
      expect(guard().isPublicRoute(route)).toBe(false);
    }
  });

  test('called with nothing, the guard judges the bare root, which is public by default and closed on request', () => {
    expect(guard().shouldRedirectToLogin()).toBe(false);
    const strict = createRouteGuard({ publicSegments: ['login'], emptyIsPublic: false });
    expect(strict.shouldRedirectToLogin()).toBe(true);
    expect(strict.shouldRedirectToLogin({ isLoading: false, isAuthenticated: false, route: '/' })).toBe(true);
  });

  test('a guard without its list of public screens is refused', () => {
    expect(() => createRouteGuard({})).toThrow(/publicSegments/);
    expect(() => createRouteGuard({ publicSegments: [] })).toThrow(/publicSegments/);
  });
});
