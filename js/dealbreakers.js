/**
 * OpenDate - Two-Way Mutual Dealbreaker & Compatibility Engine
 * Evaluates candidate profiles prior to rendering in discovery.
 * Ensures both daters mutually qualify for each other's criteria.
 */

const OpenDateDealbreakers = {
  /**
   * Evaluates if candidate and user mutually match preferences.
   * @param {object} userProfile The active user's profile
   * @param {object} candidate The candidate profile
   * @param {object} userPreferences Optional strict dealbreaker flags
   * @returns {{passes: boolean, reason?: string, sharedInterests: string[]}}
   */
  evaluateMutualCompatibility(userProfile, candidate, userPreferences = {}) {
    if (!candidate || !userProfile) {
      return { passes: false, reason: 'Incomplete profile data', sharedInterests: [] };
    }

    // 1. Gender Mutual Compatibility
    const userWants = userProfile.interestedIn || ['Everyone'];
    const candGender = candidate.gender || '';
    const candWants = candidate.interestedIn || ['Everyone'];
    const userGender = userProfile.gender || '';

    const userLikesCand = userWants.includes('Everyone') || userWants.some(g => candGender.toLowerCase().includes(g.toLowerCase()));
    const candLikesUser = candWants.includes('Everyone') || candWants.some(g => userGender.toLowerCase().includes(g.toLowerCase()));

    if (!userLikesCand || !candLikesUser) {
      return { passes: false, reason: 'Gender criteria not mutually aligned', sharedInterests: [] };
    }

    // 2. Age Range Mutual Compatibility
    const userAgeMin = userProfile.ageMin || 18;
    const userAgeMax = userProfile.ageMax || 99;
    const candAge = candidate.age || 25;

    if (candAge < userAgeMin || candAge > userAgeMax) {
      return { passes: false, reason: 'Candidate age outside your range', sharedInterests: [] };
    }

    if (candidate.ageMin && candidate.ageMax) {
      const userAge = userProfile.age || 25;
      if (userAge < candidate.ageMin || userAge > candidate.ageMax) {
        return { passes: false, reason: 'Your age outside candidate range', sharedInterests: [] };
      }
    }

    // 3. Strict Habit Dealbreakers (if user flagged)
    if (userPreferences.dealbreakerSmoking && candidate.smoking === 'Yes') {
      return { passes: false, reason: 'Candidate smokes tobacco', sharedInterests: [] };
    }
    if (userPreferences.dealbreakerDrugs && candidate.drugs === 'Yes') {
      return { passes: false, reason: 'Candidate uses recreational drugs', sharedInterests: [] };
    }

    // 4. Calculate Shared Interests for UI Highlighting
    const userInterests = new Set(userProfile.interests || []);
    const shared = (candidate.interests || []).filter(i => userInterests.has(i));

    return { passes: true, sharedInterests: shared };
  }
};

window.OpenDateDealbreakers = OpenDateDealbreakers;
window.DealbreakerEngine = OpenDateDealbreakers;
