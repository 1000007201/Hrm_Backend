import { randomBytes } from "node:crypto";
import { auth } from "./auth.js";
import { prisma } from "./prisma.js";
import { ensureDefaultLeaveTypes } from "./leaveTypes.js";

export interface RegisterCompanyInput {
  companyName: string;
  fullName: string;
  email: string;
  password: string;
}

export interface RegisterCompanyResult {
  user: { id: string; name: string; email: string };
  organization: { id: string; name: string; slug: string };
  sessionToken: string;
  authHeaders: Headers;
}

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "company";

const generateUniqueSlug = async (companyName: string): Promise<string> => {
  const baseSlug = slugify(companyName);
  let candidateSlug = baseSlug;
  while (await prisma.organization.findUnique({ where: { slug: candidateSlug } })) {
    candidateSlug = `${baseSlug}-${randomBytes(3).toString("hex")}`;
  }
  return candidateSlug;
};

// Bootstraps a new tenant: Better Auth User -> Organization (owner membership)
// -> domain Employee (ADMIN) -> active org on the session. Shared by the
// /api/register-company route and prisma/seed.ts so there is one place that
// knows how to create a company.
export const registerCompany = async ({
  companyName,
  fullName,
  email,
  password,
}: RegisterCompanyInput): Promise<RegisterCompanyResult> => {
  const signUp = await auth.api.signUpEmail({
    body: { email, password, name: fullName },
    returnHeaders: true,
  });
  if (!signUp.response) {
    throw new Error("Sign-up did not return a user");
  }
  const { user, token } = signUp.response;
  if (!token) {
    // No session token means REQUIRE_EMAIL_VERIFICATION is on and sign-up
    // skipped auto sign-in — this bootstrap flow needs a session to attach
    // the org to, so it can't proceed.
    throw new Error("Sign-up did not create a session (is email verification required?)");
  }

  let organization: { id: string; name: string; slug: string };
  try {
    const slug = await generateUniqueSlug(companyName);
    organization = await auth.api.createOrganization({
      body: { name: companyName, slug, userId: user.id },
    });
  } catch (err) {
    console.error(`[registerCompany] organization creation failed, orphaned user=${user.id}`, err);
    throw err;
  }

  try {
    await prisma.employee.create({
      data: { userId: user.id, organizationId: organization.id, fullName, email: user.email, role: "ADMIN" },
    });
    // Every new org starts with the default CL/SL/EL leave types.
    await ensureDefaultLeaveTypes(organization.id);
  } catch (err) {
    console.error(
      `[registerCompany] org setup failed for userId=${user.id} organizationId=${organization.id}; cleaning up`,
      err,
    );
    const cleanup = await Promise.allSettled([
      prisma.organization.delete({ where: { id: organization.id } }),
      prisma.user.delete({ where: { id: user.id } }),
    ]);
    for (const result of cleanup) {
      if (result.status === "rejected") {
        console.error(
          `[registerCompany] ORPHAN LEFT BEHIND — cleanup failed for userId=${user.id} organizationId=${organization.id}`,
          result.reason,
        );
      }
    }
    throw err;
  }

  await prisma.session.update({
    where: { token },
    data: { activeOrganizationId: organization.id },
  });

  return {
    user: { id: user.id, name: user.name, email: user.email },
    organization: { id: organization.id, name: organization.name, slug: organization.slug },
    sessionToken: token,
    authHeaders: signUp.headers,
  };
};
