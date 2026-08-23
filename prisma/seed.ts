import { prisma } from "../src/core/prisma.js";
import { registerCompany } from "../src/modules/identity/registerCompany.js";

const DEMO_COMPANY_NAME = process.env.DEMO_COMPANY_NAME ?? "Acme Demo Co";
const DEMO_ADMIN_NAME = process.env.DEMO_ADMIN_NAME ?? "Demo Admin";
const DEMO_ADMIN_EMAIL = process.env.DEMO_ADMIN_EMAIL ?? "admin@demo.hrm.local";
const DEMO_ADMIN_PASSWORD = process.env.DEMO_ADMIN_PASSWORD ?? "DemoPassword123!";

const main = async () => {
  const existingAdmin = await prisma.user.findUnique({ where: { email: DEMO_ADMIN_EMAIL } });
  if (existingAdmin) {
    console.log(`Seed: demo admin "${DEMO_ADMIN_EMAIL}" already exists, skipping.`);
    return;
  }

  const { user, organization } = await registerCompany({
    companyName: DEMO_COMPANY_NAME,
    fullName: DEMO_ADMIN_NAME,
    email: DEMO_ADMIN_EMAIL,
    password: DEMO_ADMIN_PASSWORD,
  });

  console.log(
    `Seed: created demo company "${organization.name}" (slug=${organization.slug}) with admin ${user.email} / password "${DEMO_ADMIN_PASSWORD}"`,
  );
};

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
