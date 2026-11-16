const purgeExpired = (revokedTokenIds, now = Date.now()) => {
  for (const [jti, expiresAt] of revokedTokenIds.entries()) {
    if (expiresAt < now) {
      revokedTokenIds.delete(jti);
    }
  }
};

const createMemoryRevocationStore = () => {
  const revokedTokenIds = new Map();
  const revokedUsers = new Map();

  return {
    async revoke(jti, expiresAt) {
      purgeExpired(revokedTokenIds);
      if (!jti) return;

      const expiresAtMs = Number(expiresAt);
      revokedTokenIds.set(jti, Number.isFinite(expiresAtMs) ? expiresAtMs : Date.now());
    },

    async isRevoked(jti) {
      purgeExpired(revokedTokenIds);
      if (!jti) return false;

      return revokedTokenIds.has(jti);
    },

    async revokeAllForUser(userId, revokedBeforeMs = Date.now()) {
      if (!userId) return;

      const revokedBefore = Number(revokedBeforeMs);
      revokedUsers.set(userId, Number.isFinite(revokedBefore) ? revokedBefore : Date.now());
    },

    async isRevokedForUser(userId, issuedAtSeconds) {
      if (!userId) return false;

      const revokedBefore = revokedUsers.get(userId);
      if (revokedBefore === undefined) return false;

      // Sans date d'émission lisible, rien ne prouve que le jeton est postérieur
      // à « déconnecter partout » : il est révoqué.
      if (issuedAtSeconds === undefined || issuedAtSeconds === null || issuedAtSeconds === '') return true;
      const issuedAtMs = Number(issuedAtSeconds) * 1000;
      if (!Number.isFinite(issuedAtMs)) return true;

      return issuedAtMs <= revokedBefore;
    }
  };
};

module.exports = {
  createMemoryRevocationStore
};
