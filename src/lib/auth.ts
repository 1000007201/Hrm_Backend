import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { organization, openAPI } from "better-auth/plugins";
import { defaultAc, defaultRoles } from "better-auth/plugins/organization/access";
import { prisma } from "./prisma.js";
import { sendEmail } from "./email.js";
import { linkEmployeeOnAcceptInvitation, getInvitationAcceptUrl } from "./invitations.js";
import { env } from "../env.js";

// Org roles mirroring EmployeeRole (ADMIN/HR/MANAGER/EMPLOYEE, lowercased —
// see toOrgRole in invitations.ts). "owner" is Better Auth's own built-in
// role and stays as-is for whoever registers the company; these four are
// what an invited employee's org membership carries. Only admin/hr get
// invitation permissions — matches the ADMIN/HR-only gate on the invite
// routes, so Better Auth's own permission check agrees with ours.
const adminOrgRole = defaultAc.newRole({
  organization: ["update"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
  team: ["create", "update", "delete"],
  ac: ["create", "read", "update", "delete"],
});
const hrOrgRole = defaultAc.newRole({
  invitation: ["create", "cancel"],
});
const managerOrgRole = defaultAc.newRole({});
const employeeOrgRole = defaultAc.newRole({});

export const auth = betterAuth({
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 10,
    maxPasswordLength: 128,
    requireEmailVerification: env.REQUIRE_EMAIL_VERIFICATION,
    resetPasswordTokenExpiresIn: 60 * 60, // 1 hour
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user, token }) => {
      const url = `${env.FRONTEND_ORIGIN}/reset-password?token=${token}`;
      // Not awaited: awaiting here would let email-provider latency leak
      // whether the address exists, defeating the timing-attack mitigation
      // Better Auth applies around this callback.
      void sendEmail({
        to: user.email,
        subject: "Reset your password",
        html: `<p>Click the link below to reset your password. This link expires in 1 hour.</p><p><a href="${url}">${url}</a></p>`,
      });
    },
    onPasswordReset: async ({ user }) => {
      console.log(`[auth] password reset for user=${user.id} email=${user.email}`);
    },
  },
  emailVerification: {
    sendVerificationEmail: async ({ user, url }) => {
      void sendEmail({
        to: user.email,
        subject: "Verify your email",
        html: `<p>Click the link below to verify your email address.</p><p><a href="${url}">${url}</a></p>`,
      });
    },
  },
  // Built-in limiter over @fastify/rate-limit: Better Auth already ships
  // stricter default windows for sign-in/sign-up (3 req/10s) and
  // password-reset/verification requests (3 req/60s) than its general
  // 100 req/10s default, so enabling it covers this without a new dependency
  // or duplicating per-route logic outside the auth handler.
  rateLimit: {
    enabled: true,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // 1 day
  },
  trustedOrigins: [env.FRONTEND_ORIGIN],
  plugins: [
    organization({
      // Org creation only happens through POST /api/register-company, which
      // calls auth.api.createOrganization server-side with a userId and no
      // session — that "system action" path bypasses this flag entirely.
      // Setting it false just blocks a signed-in user from self-service
      // creating additional orgs via Better Auth's own client-facing
      // endpoint (which wouldn't create the domain Employee row).
      allowUserToCreateOrganization: false,
      // hasPermission resolves roles via `options.roles || defaultRoles` —
      // NOT a merge — so setting `roles` at all replaces the built-ins
      // entirely unless we spread them back in. Without this, "owner"
      // silently loses every permission (including inviting) the moment a
      // custom roles map is set.
      roles: {
        ...defaultRoles,
        admin: adminOrgRole,
        hr: hrOrgRole,
        manager: managerOrgRole,
        employee: employeeOrgRole,
      },
      invitationExpiresIn: 60 * 60 * 24 * 7, // 7 days
      cancelPendingInvitationsOnReInvite: true,
      sendInvitationEmail: async ({ id, email, organization: org, inviter }) => {
        const url = getInvitationAcceptUrl(id);
        void sendEmail({
          to: email,
          subject: `You're invited to join ${org.name}`,
          html: `<p>${inviter.user.name} invited you to join <strong>${org.name}</strong>.</p><p><a href="${url}">${url}</a></p><p>This invitation expires in 7 days.</p>`,
        });
      },
      organizationHooks: {
        // The crux of the invite flow: link the accepting user to the
        // pre-existing Employee record (by org + email) instead of ever
        // creating a second one. See src/lib/invitations.ts.
        afterAcceptInvitation: async (data) => {
          await linkEmployeeOnAcceptInvitation(data);
        },
      },
    }),
    openAPI(),
  ],
});

export type Session = typeof auth.$Infer.Session;
