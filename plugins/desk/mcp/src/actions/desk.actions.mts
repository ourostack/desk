import { defineActions } from "../lib/ouro-actions/ouro-actions.mts";
import { deskSearch, deskRecall, deskSkill } from "./desk-read.actions.mts";
import { deskStatus, deskDoctor, improvementNext } from "./desk-session.actions.mts";

export default defineActions("desk", [deskSearch, deskRecall, deskSkill, deskStatus, deskDoctor, improvementNext], { tool: "desk" });
