import { createRouter, createWebHistory } from "vue-router";

import ContactConfigPage from "../pages/ContactConfigPage.vue";
import ControllerPage from "../pages/ControllerPage.vue";
import InclusionPage from "../pages/InclusionPage.vue";
import LoginPage from "../pages/LoginPage.vue";
import NodesPage from "../pages/NodesPage.vue";
import TestsPage from "../pages/TestsPage.vue";
import SystemPage from "../pages/SystemPage.vue";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/login" },
    { path: "/login", component: LoginPage },
    { path: "/controller", component: ControllerPage },
    { path: "/inclusion", component: InclusionPage },
    { path: "/nodes", component: NodesPage },
    { path: "/contact-config", component: ContactConfigPage },
    { path: "/tests", component: TestsPage },
    { path: "/system", component: SystemPage },
  ],
});
