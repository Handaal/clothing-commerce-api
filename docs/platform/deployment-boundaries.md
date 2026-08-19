# Deployment Boundaries

- API: GitHub → independent CI → future Docker image → approved Hostinger KVM VPS. A background
  worker may be added later by decision, not in Phase 1A-R.
- Storefront: independent CI/CD to Hostinger KVM or another approved web host.
- POS: Git tag → Windows Electron build/installer → future update distribution.
- Admin mobile: Git → EAS Build → Android/iOS distribution.

No deployment is configured now. Releasing one component never requires rebuilding the other
three.
