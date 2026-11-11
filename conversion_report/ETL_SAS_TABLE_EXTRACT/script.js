let source;
const componentTypes = new Set();
const jobTypes = new Set();
let jobNames = new Set();

const successComponents = new Set();
const warningComponents = new Set();
const failedComponents = new Set();

const ALL_OPTION = "All";
const NO_GENERATED_COMPONENTS = "No Generated Components";

let currentStatusFilter = "All"; // 'All' | 'Error' | 'Warning' | 'Success'

// Percentages always show one decimal place (60 -> 60.0).
function fmtPct(v) {
    return Number(v).toFixed(1);
}

function escapeHtml(str) {
    if (str === undefined || str === null) return '';
    return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------------------
// Data conversion: turns the raw JobConversionStatus JSON (produced by the
// real conversion run) into a flat, paired source/generated component list.
// ---------------------------------------------------------------------------

function convertJobConversionStatusToReport(jobConversionStatus) {
    if (!jobConversionStatus) {
        return {
            jobName: "Unknown",
            sourceToolName: window.sourceToolName || "Unknown",
            targetToolName: window.targetToolName || "Unknown",
            conversionStatus: "Unknown",
            sourceComponents: [],
            validationResults: []
        };
    }

    // Components are keyed by jobName+name (not just name) so same-named components in different
    // nested flows (e.g. two DataFlows that both have a "Filter1") don't collide/overwrite each other.
    function componentKey(jobName, name) {
        return (jobName || "Unknown Job") + "::" + name;
    }

    const allComponents = [];

    // depth: nesting level (0 = top-level pipeline, 1 = a DataFlow/SubControlFlow nested directly
    // inside it, 2 = nested inside that, etc.). ownerKey: the componentKey of the specific source
    // component this one is nested under (null at depth 0) - used below to attach each nested flow
    // to the exact item that owns it, instead of flattening/grouping everything by job name.
    //
    // Only recurses from the adoption-side occurrence of a component (source ends in _ADOPTION, or
    // is absent). The generation-side occurrence of the same activity/component carries the SAME
    // jobConversionStatus reference (see ConversionStatusHandler.getActivityConversionStatusForGeneratedComponents),
    // so recursing from both would collect every nested component twice.
    //
    // visitedJobSignatures guards against a SEPARATE duplication source: when a rule replaces a
    // container activity (e.g. an SSIS ForEach Loop Container swapped for a GetMetadata/Filter/ForEach
    // pattern), the replacement's own report entries can end up holding the SAME underlying
    // JobConversionStatus object as the original container's entry (both point at the one nested
    // subtree the Java side never cloned). JSON has no way to express that shared identity, so it
    // gets fully re-serialized at every entry that references it - the same nested components can
    // otherwise show up 2x, 3x or more. Since a genuine duplicate is byte-identical (same nested job
    // name AND the same set of child component name/source pairs), a lightweight content fingerprint
    // safely tells "the same subtree, reached twice" apart from "two different containers that
    // happen to share a name" (which would have different children and different fingerprints).
    const visitedJobSignatures = new Set();
    function jobSignature(jobStatus) {
        const childSig = (jobStatus.components || []).map((c) => c.name + ":" + c.source).join("|");
        return (jobStatus.name || "") + "##" + childSig;
    }

    // For a shared jobConversionStatus reached from more than one component (see above), only the
    // FIRST owner to reach a given signature actually recurses and collects its nested subtree
    // (sigCanonicalOwner). Every later owner reaching that same signature is recorded in
    // sigAliasOwners instead of being recursed into again - otherwise its container (e.g. the
    // generated FOREACH_* activity that replaced the original loop container) would be left with an
    // empty nestedComponents, which reads as "the nested loop body is missing" even though it was
    // converted and is simply attached to the original container's card instead. Resolved below,
    // once sourceComponentsMap exists, by pointing each alias owner at the canonical owner's already
    // -collected nestedComponents list.
    const sigCanonicalOwner = new Map();
    const sigAliasOwners = new Map();

    function collectAllComponents(jobStatus, parentJobName, parentJobType, depth, ownerKey) {
        if (jobStatus.components && Array.isArray(jobStatus.components)) {
            const isAdopted = c => c.source === "COMPONENT_ADOPTION" || c.source === "ACTIVITY_ADOPTION" || !c.source;
            const adoptedNames = new Set(jobStatus.components.filter(c => c.name && isAdopted(c)).map(c => c.name));
            jobStatus.components.forEach((component) => {
                const thisJobName = jobStatus.name || parentJobName || "Unknown Job";
                const isAdoptionSide = isAdopted(component);
                // A source task/component is its own parent. One whose parent is another adopted entry of the
                // same flow was derived by a rule (a wrapper If-condition, a Lookup split, ...): it is
                // generated output of that parent, not a source item, and neither is anything nested in it.
                const derived = isAdoptionSide && !!component.parent && component.parent !== component.name
                    && adoptedNames.has(component.parent);
                allComponents.push({
                    ...component,
                    jobType: jobStatus.jobType || parentJobType || "UNKNOWN",
                    jobName: thisJobName,
                    depth: depth,
                    ownerKey: ownerKey || null,
                    derived: derived
                });
                if (derived) return;
                if (component.jobConversionStatus && isAdoptionSide) {
                    const sig = jobSignature(component.jobConversionStatus);
                    const thisOwnerKey = componentKey(thisJobName, component.name);
                    if (visitedJobSignatures.has(sig)) {
                        if (!sigAliasOwners.has(sig)) sigAliasOwners.set(sig, []);
                        sigAliasOwners.get(sig).push(thisOwnerKey);
                        return;
                    }
                    visitedJobSignatures.add(sig);
                    sigCanonicalOwner.set(sig, thisOwnerKey);
                    collectAllComponents(component.jobConversionStatus, jobStatus.name, jobStatus.jobType,
                        depth + 1, thisOwnerKey);
                }
            });
        }
    }

    collectAllComponents(jobConversionStatus, null, null, 0, null);

    const sourceComponentsMap = {};
    const generatedComponents = [];
    // Azure SDK validation outcomes (Source.GENERATION_VALIDATION) are NOT components - they're
    // per-generated-artifact schema checks, so they're collected separately here and rendered in
    // their own report section rather than being mixed into the component list.
    const validationResultsMap = {};

    // Rule-created items (modificationStatus ADD) are not part of the source package: they are listed on
    // the generated (right) side of the activity they were derived from. Maps their key -> parent key so
    // anything nested under them re-attaches to that parent.
    const addedParentKey = {};

    allComponents.forEach((component, index) => {
        const componentSource = component.source;
        if (!component.name) return;

        const derived = !!component.derived;
        if ((derived || component.modificationStatus === "ADD") && component.parent && component.parent !== component.name
            && (componentSource === "COMPONENT_ADOPTION" || componentSource === "ACTIVITY_ADOPTION" || !componentSource)) {
            addedParentKey[componentKey(component.jobName, component.name)] = componentKey(component.jobName, component.parent);
            generatedComponents.push({
                componentName: component.name,
                displayName: component.generatedName || component.name,
                componentType: component.type || "Unknown",
                messages: convertMessages(component.messages || []),
                parent: component.parent,
                jobName: component.jobName,
                derived: derived,
                typeProperties: component.typeProperties || []
            });
        } else if (componentSource === "COMPONENT_ADOPTION" || componentSource === "ACTIVITY_ADOPTION" || !componentSource) {
            const sourceComp = {
                componentId: component.name + "_" + index,
                componentKey: componentKey(component.jobName, component.name),
                ownerKey: component.ownerKey || null,
                componentName: component.name,
                componentType: component.type || "Unknown",
                jobType: component.jobType || "UNKNOWN",
                jobName: component.jobName || "Unknown Job",
                depth: component.depth || 0,
                // Raw .parent, kept for the replacement-rollup pass below - NOT the same as ownerKey
                // (which is about nested-flow containment, not "this activity was replaced by that one").
                parent: component.parent || null,
                // ADD means a rule synthesized this item (e.g. a SetVariable materialized from a variable);
                // used by the workaround-nesting pass below to tuck it under its parent's card.
                modificationStatus: component.modificationStatus || "NONE",
                messages: convertMessages(component.messages || []),
                typeProperties: component.typeProperties || [],
                generatedComponents: [],
                nestedComponents: [],
                inConnections: [],
                outConnections: []
            };
            sourceComponentsMap[sourceComp.componentKey] = sourceComp;
        } else if (componentSource === "COMPONENT_GENERATION" || componentSource === "ACTIVITY_GENERATION") {
            generatedComponents.push({
                componentName: component.name,
                // Name in the generated artifact when the generator renamed it (e.g. ADF naming
                // standardization); componentName stays the source-side name used for matching.
                displayName: component.generatedName || component.name,
                componentType: component.type || "Unknown",
                messages: convertMessages(component.messages || []),
                parent: component.parent,
                jobName: component.jobName,
                // Carries this generated component's OWN SUCCESS-tagged properties, so the
                // property-comparison table doesn't depend solely on the adopted entry's
                // typeProperties still (accidentally) referencing the same live list.
                typeProperties: component.typeProperties || []
            });
        } else if (componentSource === "GENERATION_VALIDATION") {
            // Keyed so a resource validated more than once (e.g. the same artifact written by two
            // save() passes) collapses to a single row instead of appearing twice.
            validationResultsMap[componentKey(component.jobName, component.name)] = {
                resourceName: component.name,
                resourceType: component.type || "Unknown",
                conversionStatus: component.conversionStatus,
                jobName: component.jobName || "Unknown Job",
                messages: convertMessages(component.messages || []),
                // references to datasets / linked services / data flows / pipelines (and, on the
                // CONFIG_MAPPING entry, the connection mapping) - see renderArtifactMapping
                typeProperties: component.typeProperties || []
            };
        }
    });

    generatedComponents.forEach((genComp) => {
        // Prefer matching the generated entry to the adopted entry of the SAME name first - that's
        // the entry a rule creates for itself (e.g. a Script/SetVariable activity, or an If Condition
        // wrapper, a rule derives from an original task) and it's always the right match when it
        // exists. Only fall back to matching via .parent when no same-named adopted entry exists:
        // that covers a dataflow/SubControlFlow activity (whose .parent names its OUTER container,
        // not itself) and a rule-inserted component with no adoption-time counterpart under its own
        // name at all. Matching by .parent first would instead attach this entry to whatever OTHER
        // adopted entry .parent happens to reference (e.g. the original activity a rule replaced),
        // leaving the generated activity's own card with no Generated Components.
        const nameKey = componentKey(genComp.jobName, genComp.componentName);
        let key = sourceComponentsMap[nameKey] ? nameKey : null;
        if (!key && genComp.parent) {
            const parentKey = componentKey(genComp.jobName, genComp.parent);
            if (sourceComponentsMap[parentKey]) {
                key = parentKey;
            }
        }
        if (!key) return;
        // An added item can be reported on both sides under one name; show it once, messages merged.
        // A derived adoption-side entry (source-tool type) and its generation-side twin share a name but not
        // a type, so those match by name only.
        const dup = sourceComponentsMap[key].generatedComponents.find(
            (g) => g.componentName === genComp.componentName
                && (g.derived || genComp.derived || sameType(g.componentType, genComp.componentType)));
        if (dup) {
            dup.messages = dup.messages.concat(genComp.messages);
            if (dup.derived && !genComp.derived) {
                dup.componentType = genComp.componentType;
                dup.typeProperties = genComp.typeProperties || dup.typeProperties;
                dup.derived = false;
            }
            // the generation entry carries the real target name (e.g. ST_ prefix); the adoption-side copy doesn't
            if (genComp.displayName !== genComp.componentName) dup.displayName = genComp.displayName;
            return;
        }
        sourceComponentsMap[key].generatedComponents.push({
            componentName: genComp.componentName,
            displayName: genComp.displayName,
            componentType: genComp.componentType,
            messages: genComp.messages,
            derived: genComp.derived,
            typeProperties: genComp.typeProperties || []
        });
    });

    // Roll up a replacement activity's own generated output onto the ORIGINAL activity it replaced,
    // so the original doesn't read as "No Generated Components" (looks like a conversion failure)
    // when it actually succeeded via being swapped for something else entirely (e.g. a File System
    // Task replaced by a Delete activity, or an Execute SQL Task replaced by a Script activity).
    // The replacement still gets its own separate card too (via its own adopted entry above) - this
    // just ALSO surfaces its result on the original's card. Iterates to a fixed point (bounded) so a
    // multi-hop replacement chain (original -> intermediate stand-in -> final activity) fully
    // propagates back to the true root, not just one hop up.
    for (let pass = 0; pass < 5; pass++) {
        let changed = false;
        Object.values(sourceComponentsMap).forEach((comp) => {
            if (!comp.parent || comp.parent === comp.componentName) return;
            if (comp.generatedComponents.length === 0) return;
            const originalComp = sourceComponentsMap[componentKey(comp.jobName, comp.parent)];
            if (!originalComp || originalComp === comp) return;
            for (const gen of comp.generatedComponents) {
                const alreadyPresent = originalComp.generatedComponents.some(
                    (g) => g.componentName === gen.componentName && sameType(g.componentType, gen.componentType)
                );
                if (!alreadyPresent) {
                    originalComp.generatedComponents.push(gen);
                    changed = true;
                }
            }
        });
        if (!changed) break;
    }

    // Attach each source component to the specific item that owns its containing flow, so it renders
    // nested inside that item's own tile rather than as a separate section.
    Object.values(sourceComponentsMap).forEach((comp) => {
        let owner = comp.ownerKey;
        for (let hop = 0; owner && !sourceComponentsMap[owner] && addedParentKey[owner] && hop < 5; hop++) {
            owner = addedParentKey[owner];
        }
        if (owner && sourceComponentsMap[owner]) {
            comp.ownerKey = owner;
            sourceComponentsMap[owner].nestedComponents.push(comp);
        }
    });

    // Nest rule-ADDed workaround activities (e.g. a SetVariable materialized from a variable, which has
    // no real SSIS activity behind it) under the parent activity they were derived from/attached to,
    // instead of letting them render as their own separate top-level parent card. These are real graph
    // vertices, so they each already got their own source entry above; here we tuck that entry inside
    // its parent's card by giving it the same ownerKey the nested-flow machinery uses (which also makes
    // populateComponentDetails' top-level filter drop it from the top level). Skip anything already
    // nested via a true nested flow, and anything whose parent isn't a real sibling card in this job.
    Object.values(sourceComponentsMap).forEach((comp) => {
        if (comp.ownerKey) return;
        // Scope this strictly to rule-synthesized SetVariable workarounds (modificationStatus ADD +
        // SetVariable type), NOT every ADD activity - replacement activities (e.g. Script for Execute
        // SQL) and rule-inserted If-condition wrappers are also ADD, and they are meant to keep their
        // own top-level card.
        if (comp.modificationStatus !== "ADD") return;
        if (String(comp.componentType || "").toUpperCase() !== "SETVARIABLE") return;
        if (!comp.parent || comp.parent === comp.componentName) return;
        const parentKey = componentKey(comp.jobName, comp.parent);
        const parentComp = sourceComponentsMap[parentKey];
        if (!parentComp || parentComp === comp) return;
        comp.ownerKey = parentKey;
        parentComp.nestedComponents.push(comp);
    });

    // Give every alias owner of a shared nested subtree (see sigAliasOwners above) the SAME nested
    // list the canonical owner just collected, so e.g. both the original SSIS ForEach Loop Container
    // and the ADF ForEach activity that replaced it show the loop body - instead of only the
    // original, leaving the actually-generated activity looking like its nested flow is missing.
    sigAliasOwners.forEach((aliasOwnerKeys, sig) => {
        const canonicalOwnerKey = sigCanonicalOwner.get(sig);
        const canonicalComp = canonicalOwnerKey && sourceComponentsMap[canonicalOwnerKey];
        if (!canonicalComp) return;
        aliasOwnerKeys.forEach((aliasOwnerKey) => {
            const aliasComp = sourceComponentsMap[aliasOwnerKey];
            if (aliasComp && aliasComp !== canonicalComp) {
                aliasComp.nestedComponents = canonicalComp.nestedComponents;
            }
        });
    });

    const sourceComponents = Object.values(sourceComponentsMap);

    const conversionStatusStr = jobConversionStatus.conversionStatus
        ? (jobConversionStatus.conversionStatus === "SUCCESS" ? "Completed" : jobConversionStatus.conversionStatus)
        : "Unknown";

    return {
        jobName: jobConversionStatus.name || "Unknown",
        sourceToolName: window.sourceToolName || "Unknown",
        targetToolName: window.targetToolName || "Unknown",
        conversionStatus: conversionStatusStr,
        sourceComponents: sourceComponents,
        // CONFIG_MAPPING is bookkeeping for the mapping tables, not a validated artifact
        validationResults: Object.values(validationResultsMap).filter(v => v.resourceType !== "CONFIG_MAPPING"),
        configMapping: Object.values(validationResultsMap).find(v => v.resourceType === "CONFIG_MAPPING") || null
    };
}

// Adoption-side types are upper-case (SCRIPT), generation-side mixed-case (Script).
function sameType(a, b) {
    return String(a).toLowerCase() === String(b).toLowerCase();
}

function convertMessages(messages) {
    if (!messages || !Array.isArray(messages) || messages.length === 0) return [];
    const converted = messages.map(msg => ({
        message: msg.message || "No message",
        // A message flagged unsupported (no target equivalent, e.g. unknown component/task) is
        // highlighted as an error so the component lands under "Manual Review".
        messageCategory: msg.unsupported ? "Error" : convertPriorityToCategory(msg.messageType)
    }));
    // Client-side backstop for ConversionStatusHandler.dedupeMessages (the same message text +
    // severity showing up twice on one component) - cheap safety net on top of the server-side fix,
    // not a replacement for it.
    const seen = new Set();
    return converted.filter((m) => {
        const key = m.message + "##" + m.messageCategory;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function convertPriorityToCategory(priority) {
    if (!priority) return "Info";
    switch (String(priority).toUpperCase()) {
        case "ERROR": return "Error";
        case "WARNING":
        case "WARN": return "Warning";
        case "SUCCESS": return "Success";
        default: return "Info";
    }
}

function reorderComponents(response, inComponents) {
    if (!response || !Array.isArray(response)) return [];
    const outComponents = [];
    const processComponents = [];
    for (const src of response) {
        const inConnections = src.inConnections || [];
        const outConnections = src.outConnections || [];
        if (inConnections.length < 1 && outConnections.length > 0) inComponents.push(src);
        else if (inConnections.length > 0 && outConnections.length < 1) outComponents.push(src);
        else processComponents.push(src);
    }
    return [...inComponents, ...processComponents, ...outComponents];
}

// ---------------------------------------------------------------------------
// Message counting / component status classification
// ---------------------------------------------------------------------------

function getMessageCount(messages, countMsg = { successMessages: 0, infoMessages: 0, errorMessages: 0, warnMessages: 0 }) {
    if (messages && Array.isArray(messages)) {
        for (const msg of messages) {
            switch (msg.messageCategory) {
                case "Success": countMsg.successMessages++; break;
                case "Info": countMsg.infoMessages++; break;
                case "Error": countMsg.errorMessages++; break;
                case "Warning": countMsg.warnMessages++; break;
                default: break;
            }
        }
    }
    return countMsg;
}

function countBadgesForSrcComponent(currSrcComp) {
    const sourceMessages = currSrcComp.messages || [];
    const generatedComponents = currSrcComp.generatedComponents || [];
    let counts = { successMessages: 0, infoMessages: 0, errorMessages: 0, warnMessages: 0 };

    counts = getMessageCount(sourceMessages, counts);
    for (const genComponent of generatedComponents) {
        counts = getMessageCount(genComponent.messages, counts);
    }

    // Error = unsupported, Partial = some properties not converted, Completed = fully converted (see scoreStatus).
    const st = scoreStatus(currSrcComp, counts);
    if (st === "Error") failedComponents.add(currSrcComp.componentId);
    else if (st === "Partial") warningComponents.add(currSrcComp.componentId);
    else successComponents.add(currSrcComp.componentId);

    if (currSrcComp.jobName) jobNames.add(currSrcComp.jobName);

    return counts;
}

// ---------------------------------------------------------------------------
// Overall summary (KPIs), computed once from the full unfiltered component list
// ---------------------------------------------------------------------------

// A source component's own typeProperties only ever carries the PARTIAL (adopted) values reliably.
// The SUCCESS (generated) values for the SAME property name may instead live on one of its paired
// generatedComponents' own typeProperties (each generated entry now carries its own snapshot - see
// ConversionStatusHandler.getComponentsForGeneratedComponents) rather than on this shared array, so
// merge both before comparing " adopted vs. generated" for a property name.
function mergedTypeProperties(comp) {
    const merged = (comp.typeProperties || []).slice();
    for (const gen of (comp.generatedComponents || [])) {
        merged.push(...(gen.typeProperties || []));
    }
    return merged;
}

function computeOverallSummary(allComponents) {
    // Counts cover the source ETL components only - rule-added entries (modificationStatus ADD, e.g.
    // replacement activities) are generated artifacts, not part of the source package.
    allComponents = allComponents.filter(c => c.modificationStatus !== "ADD");
    const summary = {
        totalComponents: allComponents.length,
        errorComponents: 0, warnComponents: 0, successComponents: 0,
        totalMessages: { error: 0, warn: 0, info: 0, success: 0 },
        propsTotal: 0, propsMapped: 0
    };

    for (const comp of allComponents) {
        let counts = getMessageCount(comp.messages || []);
        for (const gen of (comp.generatedComponents || [])) counts = getMessageCount(gen.messages || [], counts);

        summary.totalMessages.error += counts.errorMessages;
        summary.totalMessages.warn += counts.warnMessages;
        summary.totalMessages.info += counts.infoMessages;
        summary.totalMessages.success += counts.successMessages;

        const st = scoreStatus(comp, counts);
        if (st === "Error") summary.errorComponents++;
        else if (st === "Partial") summary.warnComponents++;
        else summary.successComponents++;

        const byKey = new Map();
        for (const prop of mergedTypeProperties(comp)) {
            const key = prop.key || prop.name;
            if (!byKey.has(key)) byKey.set(key, {});
            if (prop.conversionStatus === "PARTIAL") byKey.get(key).source = prop.value;
            else if (prop.conversionStatus === "SUCCESS") byKey.get(key).generated = prop.value;
        }
        byKey.forEach(v => {
            const hasSource = v.source !== undefined && v.source !== null && v.source !== "";
            const hasGenerated = v.generated !== undefined && v.generated !== null && v.generated !== "";
            // A property with no value on EITHER side is N/A for this component instance (e.g. the
            // Sql_Query property on an OLE DB source configured for a table, not a query) - not a
            // genuine mapping opportunity, so it shouldn't count against the mapped-property rate.
            if (!hasSource && !hasGenerated) return;
            summary.propsTotal++;
            if (hasSource && hasGenerated) summary.propsMapped++;
        });
    }

    return summary;
}

// Conversion summary computed in Java (ConversionPercentageCalculator): equal split of 100 at every level (tasks, data-flow components, properties).
function weightedSummary() {
    return (typeof jobConversionData !== 'undefined' && jobConversionData && jobConversionData.summary) || null;
}

// The scored row (ConversionPercentageCalculator) of a source component: status, score and property results.
let scoreRowsByKey = null;
function scoreRow(comp) {
    const ws = weightedSummary();
    if (!ws || !ws.components) return null;
    if (!scoreRowsByKey) {
        scoreRowsByKey = new Map();
        ws.components.forEach(d => scoreRowsByKey.set((d.container || "") + "|" + d.name, d));
    }
    return scoreRowsByKey.get((comp.jobName || "") + "|" + comp.componentName) || null;
}

// "Completed" | "Partial" | "Error". Falls back to the message counts when the component was not scored.
function scoreStatus(comp, counts) {
    const d = scoreRow(comp);
    if (d) return d.status === "UNSUPPORTED" ? "Error" : d.status === "PARTIAL" ? "Partial" : "Completed";
    if (counts.errorMessages > 0) return "Error";
    return counts.warnMessages > 0 ? "Partial" : "Completed";
}

function renderStatusBar(summary) {
    const bar = document.getElementById("statusBar");
    if (!bar) return;
    let label, dot, textColor, bg;
    if (summary.errorComponents > 0) { label = "Completed with Errors"; dot = "bg-error"; textColor = "text-error"; bg = "bg-red-50"; }
    else if (summary.warnComponents > 0) { label = "Completed with Workarounds Applied"; dot = "bg-amber-500"; textColor = "text-amber-700"; bg = "bg-amber-50"; }
    else { label = "Completed Successfully"; dot = "bg-tertiary"; textColor = "text-tertiary"; bg = "bg-emerald-50"; }
    // Warnings mean a workaround was applied (no direct target mapping), so they count as converted.
    const successPct = weightedSummary() ? weightedSummary().conversionPercentage : (summary.totalComponents ? Math.round(((summary.successComponents + summary.warnComponents) / summary.totalComponents) * 1000) / 10 : 0);
    bar.innerHTML = `<span class="inline-flex items-center gap-1 px-2 py-[3px] rounded ${bg} ${textColor} font-mono text-[12px] font-semibold"><span class="w-2 h-2 rounded-full ${dot}"></span>${label}</span>`;
}

function kpiCard(label, value, sub, extraHtml) {
    const card = document.createElement('div');
    card.className = "bg-surface-container-lowest rounded p-3 shadow-sm flex flex-col gap-2";
    card.innerHTML = `<span class="text-[11px] font-semibold uppercase tracking-wide text-on-surface-variant">${escapeHtml(label)}</span>
        <div class="flex items-baseline gap-1"><span class="text-[26px] font-bold text-on-surface">${escapeHtml(String(value))}</span><span class="text-[12px] text-on-surface-variant">${escapeHtml(sub)}</span></div>
        ${extraHtml || ''}`;
    return card;
}

function renderKpiCards(summary) {
    const container = document.getElementById("kpiCards");
    if (!container) return;
    container.innerHTML = '';

    // Warnings mean a workaround was applied (no direct target mapping), so they count as converted.
    const successPct = summary.totalComponents ? Math.round(((summary.successComponents + summary.warnComponents) / summary.totalComponents) * 1000) / 10 : 0;
    const propsPct = summary.propsTotal ? Math.round((summary.propsMapped / summary.propsTotal) * 1000) / 10 : null;
    const totalMsgs = summary.totalMessages.error + summary.totalMessages.warn + summary.totalMessages.info + summary.totalMessages.success;

    const ws = weightedSummary();
    if (ws) {
        container.appendChild(kpiCard("Conversion Percentage", Number(ws.conversionPercentage).toFixed(2) + "%", "Converted",
            `<div class="flex items-center gap-2 text-[11px] font-mono"><span class="px-1.5 py-[1px] rounded bg-emerald-50 text-tertiary">${ws.convertedCount} Converted</span><span class="px-1.5 py-[1px] rounded bg-amber-50 text-amber-700">${ws.partialCount} Partial</span><span class="px-1.5 py-[1px] rounded bg-red-50 text-error">${ws.unsupportedCount} Unsupported</span></div>`));
    }

    // Tasks vs data-flow components, each as converted / total (falls back to the old counts without a weighted summary).
    const rows = (ws && ws.components) || [];
    const taskAll = rows.filter(x => x.task).length, compAll = rows.length - taskAll;
    container.appendChild(kpiCard("Total Components", ws ? rows.length : summary.totalComponents, "Total",
        ws ? `<div class="flex items-center gap-2 text-[11px] font-mono"><span class="px-1.5 py-[1px] rounded bg-surface-container text-on-surface-variant">${taskAll} Tasks</span><span class="px-1.5 py-[1px] rounded bg-surface-container text-on-surface-variant">${compAll} Components</span></div>`
           : `<div class="flex items-center gap-3 text-[11px] font-mono text-on-surface-variant"><span>Success: <strong class="text-tertiary">${summary.successComponents}</strong></span><span>Workarounds: <strong class="text-amber-600">${summary.warnComponents}</strong></span><span>Errors: <strong class="text-error">${summary.errorComponents}</strong></span></div>`));

    container.appendChild(kpiCard("Component Success Rate", fmtPct(successPct) + "%", "No errors",
        `<div class="text-[12px] text-on-surface-variant">Based on ${summary.totalComponents} converted component(s).</div>`));

    container.appendChild(kpiCard("Message Diagnostics", totalMsgs, "Messages",
        `<div class="flex items-center gap-2 text-[11px] font-mono"><span class="px-1.5 py-[1px] rounded bg-red-50 text-error">${summary.totalMessages.error} Errors</span><span class="px-1.5 py-[1px] rounded bg-amber-50 text-amber-700">${summary.totalMessages.warn} Workarounds</span><span class="px-1.5 py-[1px] rounded bg-surface-container text-on-surface-variant">${summary.totalMessages.info} Info</span></div>`));
}

function renderStatusChips(summary) {
    const container = document.getElementById("statusChips");
    if (!container) return;
    container.innerHTML = '';
    const chips = [
        { key: "All", label: "All", count: summary.totalComponents, dot: "bg-outline" },
        { key: "Success", label: "Completed", count: summary.successComponents, dot: "bg-tertiary" },
        { key: "Warning", label: "Partial", count: summary.warnComponents, dot: "bg-amber-500" },
        { key: "Error", label: "Error", count: summary.errorComponents, dot: "bg-error" }
    ];
    chips.forEach(chip => {
        const btn = document.createElement('button');
        btn.className = "px-3 py-1 rounded text-[12px] font-semibold flex items-center gap-1 transition-colors " +
            (currentStatusFilter === chip.key ? "bg-surface-container text-on-surface" : "hover:bg-surface-container-low text-on-surface-variant");
        btn.innerHTML = `<span class="w-1.5 h-1.5 rounded-full ${chip.dot}"></span><span>${chip.label}</span><span class="px-1 rounded-full bg-surface-container-highest text-on-surface-variant text-[10px]">${chip.count}</span>`;
        btn.addEventListener('click', () => {
            currentStatusFilter = chip.key;
            renderStatusChips(summary);
            filterData();
        });
        container.appendChild(btn);
    });
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

function filterData() {
    if (!source || !Array.isArray(source)) return;
    let tempComponents = [...source];

    const typeSelect = document.getElementById("selectedType");
    const searchInput = document.getElementById("searchTerm");
    const selectedType = typeSelect ? typeSelect.value : "";
    const searchTerm = searchInput ? searchInput.value : "";

    if (selectedType && selectedType !== ALL_OPTION) {
        tempComponents = tempComponents.filter(src => src.componentType === selectedType);
    }

    if (currentStatusFilter === "Error") {
        tempComponents = tempComponents.filter(src => failedComponents.has(src.componentId));
    } else if (currentStatusFilter === "Warning") {
        tempComponents = tempComponents.filter(src => warningComponents.has(src.componentId));
    } else if (currentStatusFilter === "Success") {
        tempComponents = tempComponents.filter(src => successComponents.has(src.componentId));
    }

    if (searchTerm) {
        const lower = searchTerm.toLowerCase();
        // Also match a generated counterpart's renamed (e.g. prefix-standardized) name.
        tempComponents = tempComponents.filter(x => x.componentName.toLowerCase().includes(lower)
            || (x.generatedComponents || []).some(g => (g.displayName || "").toLowerCase().includes(lower)));
    }

    populateComponentDetails(tempComponents);
}

function resetFilters() {
    const typeSelect = document.getElementById("selectedType");
    const searchInput = document.getElementById("searchTerm");
    if (typeSelect) typeSelect.value = "";
    if (searchInput) searchInput.value = "";
    currentStatusFilter = "All";
    const summary = computeOverallSummary(source || []);
    renderStatusChips(summary);
    if (source && Array.isArray(source)) populateComponentDetails(source);
}

function populateDropdowns() {
    const options = Array.from(componentTypes);
    const selectedType = document.getElementById("selectedType");
    if (selectedType) {
        selectedType.innerHTML = '';
        selectedType.add(new Option('All Component Types', ALL_OPTION));
        options.forEach(option => selectedType.add(new Option(option, option)));
    }
}

// ---------------------------------------------------------------------------
// Component tiles
// ---------------------------------------------------------------------------

function statusPill(counts, status, row) {
    const span = document.createElement('span');
    let label, cls;
    if (status === "Error") { label = "Error"; cls = "bg-red-50 text-error"; }
    else if (status === "Partial") { label = "Partial"; cls = "bg-amber-50 text-amber-700"; }
    else { label = "Completed"; cls = "bg-emerald-50 text-tertiary"; }
    if (row) label += ` | ${Number(row.percentage).toFixed(2)}%`;
    span.className = `px-2 py-[2px] rounded font-mono text-[11px] font-semibold whitespace-nowrap ${cls}`;
    span.textContent = label;
    return span;
}

// Why a partial / unsupported component lost score: every property that did not fully convert, with its reason.
function renderScoreDetails(row) {
    const wrap = document.createElement('div');
    wrap.className = "bg-surface-container-low rounded p-3 flex flex-col gap-2 text-[12px]";
    const resCls = { PASS: "text-tertiary", PARTIAL: "text-amber-600", FAIL: "text-error", SKIPPED: "text-on-surface-variant" };
    const resTxt = { PASS: "Converted", PARTIAL: "Partial", FAIL: "Failed" };
    // every property of the component, converted ones included - not only those that lost points
    // properties with no equivalent / no need in the target (SKIPPED) are left out: they neither convert nor fail
    const rows = (row.properties || []).filter(p => p.result !== "SKIPPED");
    const cleanReason = r => String(r || "").replace(/\s+in (the )?target ETL tool/gi, "");
    // The component's own points are its share of the package (e.g. 2.63); each property earns its share of
    // those points - not of 100.
    const compPoints = Number(row.absoluteWeight != null ? row.absoluteWeight : row.weight) || 0;
    const pts = v => (Number(v) * compPoints / 100).toFixed(2);
    const cell = "py-1 pr-3 align-top text-[12px] leading-5";
    wrap.innerHTML = `<div class="font-mono">Score <strong>${Number(row.percentage).toFixed(2)}%</strong> | ${row.propsConverted} of ${row.propsTotal} properties converted | weight in package ${compPoints.toFixed(2)}</div>`
        + (rows.length ? `<table class="w-full text-left table-fixed"><colgroup><col style="width:44px"><col style="width:20%"><col style="width:20%"><col style="width:20%"><col></colgroup><thead class="text-[10px] uppercase tracking-wide text-on-surface-variant"><tr><th class="py-1 pr-3 align-top">#</th><th class="py-1 pr-3 align-top">Property</th><th class="py-1 pr-3 align-top">Status</th><th class="py-1 pr-3 align-top text-right">Points</th><th class="py-1 align-top">Reason</th></tr></thead><tbody>${
            rows.map((p, n) => {
                const reason = cleanReason(p.reason).trim();
                return `<tr class="border-t border-surface-container"><td class="${cell} font-mono text-on-surface-variant">${n + 1}</td><td class="${cell} font-mono break-words">${escapeHtml(p.name)}</td><td class="${cell} font-semibold whitespace-nowrap ${resCls[p.result] || ""}">${resTxt[p.result] || escapeHtml(p.result)}</td><td class="${cell} text-right font-mono whitespace-nowrap">${pts(p.earned)} / ${pts(p.weight)}</td><td class="py-1 align-top text-[12px] leading-5 break-words">${reason ? escapeHtml(reason) : "-"}</td></tr>`;
            }).join("")}</tbody></table>`
            : `<div class="text-on-surface-variant">${escapeHtml(cleanReason((row.issues && row.issues[0] && row.issues[0].message) || "No target equivalent."))}</div>`);
    return wrap;
}

function createMsgBadge(count, msgType) {
    const span = document.createElement('span');
    const styles = {
        error: "bg-red-50 text-error", warn: "bg-amber-50 text-amber-700",
        info: "bg-sky-50 text-sky-700", success: "bg-emerald-50 text-tertiary"
    };
    span.className = `px-1.5 py-[1px] rounded font-mono text-[10px] font-semibold ${styles[msgType] || ''} ${count === 0 ? 'opacity-40' : ''}`;
    span.textContent = count;
    span.title = (msgType === "warn" ? "workaround" : msgType) + " messages";
    return span;
}

function sectionLabel(text) {
    const div = document.createElement('div');
    div.className = "text-[11px] font-semibold uppercase tracking-wide text-on-surface-variant";
    div.textContent = text;
    return div;
}

function appendMessageList(messages, container) {
    if (!messages || messages.length === 0) {
        const p = document.createElement('div');
        p.className = "placeholder-value font-mono text-[12px] py-1";
        p.textContent = "No messages";
        container.appendChild(p);
        return;
    }
    const styleFor = {
        Error: ["error", "bg-red-50 text-red-900"],
        Warning: ["build_circle", "bg-amber-50 text-amber-900"],
        Success: ["check_circle", "bg-emerald-50 text-emerald-900"],
        Info: ["info", "bg-surface-container text-on-surface-variant"]
    };
    for (const msg of messages) {
        const [icon, cls] = styleFor[msg.messageCategory] || styleFor.Info;
        const item = document.createElement('div');
        item.className = `p-2 rounded flex items-start gap-1.5 font-mono text-[11px] ${cls}`;
        item.innerHTML = `<span class="material-symbols-outlined text-[15px] mt-[1px]">${icon}</span><span>${escapeHtml(msg.message)}</span>`;
        container.appendChild(item);
    }
}

function diagnosticsPanel(title, icon, iconColorClass, messages) {
    const panel = document.createElement('div');
    panel.className = "bg-surface-container-low rounded p-3 flex flex-col gap-2";
    const header = document.createElement('div');
    header.className = "flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-on-surface-variant border-b border-surface-container pb-1";
    header.innerHTML = `<span class="material-symbols-outlined text-[15px] ${iconColorClass}">${icon}</span><span>${escapeHtml(title)}</span>`;
    panel.appendChild(header);
    appendMessageList(messages, panel);
    return panel;
}

// Always-visible two-column layout: left = source diagnostics, right = every
// generated component's diagnostics stacked underneath each other.
function renderMessageComparison(sourceMessages, generatedComponents) {
    const grid = document.createElement('div');
    grid.className = "grid grid-cols-1 lg:grid-cols-2 gap-3";

    grid.appendChild(diagnosticsPanel("Source Diagnostics", "data_object", "text-primary", sourceMessages));

    const rightPanel = document.createElement('div');
    rightPanel.className = "bg-surface-container-low rounded p-3 flex flex-col gap-2";
    const rightHeader = document.createElement('div');
    rightHeader.className = "flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-on-surface-variant border-b border-surface-container pb-1";
    rightHeader.innerHTML = `<span class="material-symbols-outlined text-[15px] text-tertiary">cloud_sync</span><span>Generated Diagnostics</span>`;
    rightPanel.appendChild(rightHeader);

    if (!generatedComponents || generatedComponents.length === 0) {
        const p = document.createElement('div');
        p.className = "placeholder-value font-mono text-[12px] py-1";
        p.textContent = NO_GENERATED_COMPONENTS;
        rightPanel.appendChild(p);
    } else {
        generatedComponents.forEach((genComp, idx) => {
            if (idx > 0) {
                const hr = document.createElement('hr');
                hr.className = "border-surface-container";
                rightPanel.appendChild(hr);
            }
            const nameEl = document.createElement('div');
            nameEl.className = "flex flex-col min-w-0";
            // Name over type, matching how the source component is presented.
            nameEl.innerHTML = `<span class="componentName font-mono font-semibold text-[13px] text-on-surface">${escapeHtml(genComp.displayName || genComp.componentName)}</span><span class="componentType font-mono text-[11px] text-on-surface-variant">${escapeHtml(genComp.componentType || "Unknown")}</span>`;
            rightPanel.appendChild(nameEl);
            appendMessageList(genComp.messages, rightPanel);
        });
    }

    grid.appendChild(rightPanel);
    return grid;
}

// Groups typeProperties by name and renders a table: Source (adopted/PARTIAL)
// vs. Generated (SUCCESS) value, with "Not Mapped" / "N/A" fallbacks.
function renderPropertiesPanel(typeProperties) {
    const wrap = document.createElement('div');
    wrap.className = "overflow-x-auto rounded border border-surface-container";
    const table = document.createElement('table');
    table.className = "w-full text-left border-collapse font-mono text-[11px]";
    table.innerHTML = `<thead><tr class="bg-surface-container-high text-on-surface-variant text-[10px] uppercase tracking-wide">
        <th class="py-1.5 px-3 w-1/2">Adopted (Source)</th>
        <th class="py-1.5 px-3 w-1/2">Generated (Target)</th>
        <th class="py-1.5 px-3 text-right">Status</th>
    </tr></thead>`;
    const tbody = document.createElement('tbody');
    tbody.className = "divide-y divide-surface-container";

    const byKey = new Map();
    for (const prop of (typeProperties || [])) {
        const key = prop.key || prop.name;
        if (!byKey.has(key)) byKey.set(key, {});
        // Source/generated names are tracked separately (SSIS-native vs. ADF-native) even though
        // they're paired under the same key - see ComponentProperties#getSourceParamName/getTargetParamName.
        if (prop.conversionStatus === "PARTIAL") { byKey.get(key).source = prop.value; byKey.get(key).sourceName = prop.name; }
        else if (prop.conversionStatus === "SUCCESS") { byKey.get(key).generated = prop.value; byKey.get(key).targetName = prop.name; }
    }

    byKey.forEach((values, key) => {
        const hasSource = values.source !== undefined && values.source !== null && values.source !== "";
        const hasGenerated = values.generated !== undefined && values.generated !== null && values.generated !== "";
        const sourceName = values.sourceName || key;
        const targetName = values.targetName || key;

        let statusHtml;
        if (hasSource && hasGenerated) {
            statusHtml = `<span class="inline-flex items-center gap-1 text-tertiary font-semibold"><span class="material-symbols-outlined text-[14px]">check</span>Mapped</span>`;
        } else if (hasSource) {
            statusHtml = `<span class="inline-flex items-center gap-1 text-amber-700 font-semibold"><span class="material-symbols-outlined text-[14px]">warning</span>Not Mapped</span>`;
        } else {
            statusHtml = `<span class="text-on-surface-variant font-semibold">N/A</span>`;
        }

        const sourceValueHtml = hasSource ? escapeHtml(values.source) : `<span class="placeholder-value">N/A</span>`;
        const generatedValueHtml = hasGenerated ? escapeHtml(values.generated) : `<span class="placeholder-value">Not Mapped</span>`;

        const tr = document.createElement('tr');
        tr.className = "hover:bg-surface-container-low transition-colors";
        tr.innerHTML = `
          <td class="py-1.5 px-3 align-top"><div class="flex flex-col"><span class="font-semibold text-on-surface">${escapeHtml(sourceName)}</span><span class="text-on-surface-variant">${sourceValueHtml}</span></div></td>
          <td class="py-1.5 px-3 align-top"><div class="flex flex-col"><span class="font-semibold text-primary">${escapeHtml(targetName)}</span><span class="text-on-surface-variant">${generatedValueHtml}</span></div></td>
          <td class="py-1.5 px-3 text-right">${statusHtml}</td>`;
        tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
}

// ---------------------------------------------------------------------------
// Azure Data Factory validation section
// ---------------------------------------------------------------------------

// Renders the per-artifact Azure SDK schema-validation outcomes (pipelines, dataflows, flowlets)
// in their own section. These are NOT components - they're checks on the generated ADF JSON's
// properties - so they deliberately live outside the component list and its property mappings.
// KPI cards for the validation report: artifact outcomes instead of conversion figures.
function renderValidationCards(results) {
    const container = document.getElementById("kpiCards");
    if (!container) return;
    container.innerHTML = "";
    const failed = results.filter(v => v.conversionStatus === "FAIL");
    const broken = failed.filter(v => v.resourceType === "DATAFLOW_GRAPH").length;
    const passed = results.length - failed.length;
    const passPct = results.length ? Math.round(passed / results.length * 1000) / 10 : 0;
    const byType = {};
    results.forEach(v => { byType[v.resourceType || "Unknown"] = (byType[v.resourceType || "Unknown"] || 0) + 1; });
    const msgs = { error: 0, warn: 0 };
    results.forEach(v => (v.messages || []).forEach(m => {
        if (m.messageCategory === "Error") msgs.error++;
        else if (m.messageCategory === "Warning") msgs.warn++;
    }));

    container.appendChild(kpiCard("Artifacts Validated", results.length, "Generated artifacts",
        `<div class="flex items-center gap-3 flex-wrap text-[11px] font-mono text-on-surface-variant">${Object.entries(byType).map(([t, n]) => `<span>${escapeHtml(t)}: <strong>${n}</strong></span>`).join("")}</div>`));
    container.appendChild(kpiCard("Validation Pass Rate", fmtPct(passPct) + "%", "",
        `<div class="text-[12px] text-on-surface-variant">${passed} of ${results.length} artifact(s) passed.</div>`));
    container.appendChild(kpiCard("Need Manual Review", failed.length, "Artifacts",
        `<div class="text-[12px] text-on-surface-variant">${broken} broken data flow graph(s).</div>`));
    container.appendChild(kpiCard("Validation Findings", msgs.error + msgs.warn, "Messages",
        `<div class="flex items-center gap-2 text-[11px] font-mono"><span class="px-1.5 py-[1px] rounded bg-red-50 text-error">${msgs.error} Errors</span><span class="px-1.5 py-[1px] rounded bg-amber-50 text-amber-700">${msgs.warn} Warnings</span></div>`));
}

// ---------------------------------------------------------------------------
// Artifact mapping / connection mapping / linked service usage (validation report)
// ---------------------------------------------------------------------------

function sectionShell(id, title, noteHtml) {
    const el = document.getElementById(id);
    if (!el) return null;
    el.innerHTML = `<h2 class="text-[13px] font-semibold uppercase tracking-wide text-on-surface-variant">${escapeHtml(title)}</h2>${noteHtml || ""}`;
    el.style.display = "flex";
    return el;
}

function simpleTable(headers, rowsHtml, widths) {
    const wrap = document.createElement('div');
    wrap.className = "overflow-x-auto rounded border border-surface-container bg-surface-container-lowest shadow-sm";
    const cols = widths ? `<colgroup>${widths.map(w => `<col style="width:${w}">`).join("")}</colgroup>` : "";
    wrap.innerHTML = `<table class="w-full text-left border-collapse font-mono text-[11px]${widths ? " table-fixed" : ""}">${cols}<thead><tr class="bg-surface-container-high text-on-surface-variant text-[10px] uppercase tracking-wide">${headers.map(h => `<th class="py-1.5 px-3">${h}</th>`).join("")}</tr></thead><tbody class="divide-y divide-surface-container">${rowsHtml.join("")}</tbody></table>`;
    return wrap;
}

const td = html => `<td class="py-1.5 px-3 align-top">${html}</td>`;
const refsOf = (v, type) => (v.typeProperties || []).filter(p => p.name === type).map(p => p.value);
const refTypeLabel = { DatasetReference: "Dataset", LinkedServiceReference: "Linked Service", DataFlowReference: "Data Flow", PipelineReference: "Pipeline" };
// "DF_Get_Metadata_1" and "get_metadata_1" are the same artifact under different naming standards
const normName = n => String(n || "").toLowerCase().replace(/^(df|ppl|pl|ds|st|cpd|fl)_/, "").replace(/[^a-z0-9]/g, "");

// Only artifacts that exist as a physical file in the target are listed. Today that is pipelines,
// data flows / flowlets, datasets and linked services; a task that starts producing another kind of
// file just needs its resource type added here (it is then matched and shown automatically).
const PHYSICAL_ARTIFACT_TYPES = new Set(["PIPELINE", "DATAFLOW", "FLOWLET", "DATASET", "LINKEDSERVICE", "LINKED_SERVICE"]);

function renderArtifactMapping(report) {
    const physical = (report.validationResults || []).filter(v => PHYSICAL_ARTIFACT_TYPES.has(String(v.resourceType).toUpperCase()));
    // linked services are created too, but are not schema-validated: take them from the generator's list
    const cm = report.configMapping;
    const linkedServices = cm ? (cm.typeProperties || []).filter(p => p.name === "LINKED_SERVICE").map(p => {
        const [name, type] = p.value.split("|");
        return { resourceName: name, resourceType: "LINKED_SERVICE", adfType: type, typeProperties: [] };
    }) : [];
    const all = physical.concat(linkedServices);
    const pipelineByName = new Map(all.filter(v => v.resourceType === "PIPELINE").map(v => [String(v.resourceName).toLowerCase(), v]));

    const artifactChip = v => `<span class="text-primary font-semibold">${escapeHtml(v.resourceName)}</span> <span class="text-on-surface-variant">(${escapeHtml(v.adfType ? v.resourceType + " - " + v.adfType : v.resourceType)})</span>`;
    // the artifact plus what it points at (data flow -> datasets, dataset -> linked service, ...)
    const artifactHtml = v => {
        const uses = [];
        Object.keys(refTypeLabel).forEach(t => refsOf(v, t).forEach(n => uses.push(`${refTypeLabel[t]}: ${escapeHtml(n)}`)));
        return `<div class="mb-1">${artifactChip(v)}${uses.length ? `<div class="text-[10px] text-on-surface-variant pl-3">uses ${uses.join(" | ")}</div>` : ""}</div>`;
    };
    const note = text => `<div class="text-[11px] text-amber-800 italic mb-1">${text}</div>`;
    const nameOf = g => escapeHtml(g.displayName || g.componentName);

    const used = new Set();
    const rows = [];
    const addRow = (srcName, srcType, targetHtml, targets) => {
        (targets || []).forEach(t => used.add(String(t.resourceName).toLowerCase()));
        rows.push(`<tr class="hover:bg-surface-container-low">${td(`<div class="font-semibold text-on-surface">${escapeHtml(srcName)}</div><div class="text-on-surface-variant">${escapeHtml(srcType)}</div>`)}${td(targetHtml)}</tr>`);
    };

    // package -> pipeline(s)
    const pipelines = all.filter(v => v.resourceType === "PIPELINE");
    const pkgKey = normName(report.jobName);
    const pkgPipes = pipelines.filter(v => normName(v.resourceName).includes(pkgKey) || pkgKey.includes(normName(v.resourceName)));
    const pkgTargets = pkgPipes.length ? pkgPipes : pipelines;
    addRow(report.jobName, "Package", pkgTargets.length ? pkgTargets.map(artifactHtml).join("") : `<span class="placeholder-value">No generated artifact</span>`, pkgTargets);

    // every other source task / component that has a physical artifact in the target
    const seen = new Set();
    (report.sourceComponents || []).forEach(c => {
        if (seen.has(c.componentName)) return;
        seen.add(c.componentName);
        const generated = c.generatedComponents || [];
        const isDataFlow = /data\s*flow/i.test(c.componentType || "");
        const copies = generated.filter(g => /copy/i.test(g.componentType || ""));
        const replication = generated.filter(g => /executepipeline/i.test(g.componentType || ""));
        const keys = new Set([normName(c.componentName)].concat(generated.map(g => normName(g.displayName || g.componentName))));
        const matched = all.filter(v => v.resourceType !== "LINKED_SERVICE" && !used.has(String(v.resourceName).toLowerCase()) && keys.has(normName(v.resourceName)));

        const parts = [];
        if (copies.length) {
            // converted to a Copy Data activity inside the pipeline: nothing of its own is written to disk
            parts.push(copies.map(g => `<div class="mb-1"><span class="text-primary font-semibold">${nameOf(g)}</span> <span class="text-on-surface-variant">(Copy Data activity)</span></div>`).join("")
                + note("Only a Copy Data activity is created &mdash; no separate artifact (physical file) is created as the data flow is transformed to Copy Data."));
        } else {
            parts.push(matched.map(artifactHtml).join(""));
        }
        // a pipeline run on behalf of this task (a data flow runs through a replication pipeline; an Execute Package task calls its pipeline)
        const calledPipelines = [];
        replication.forEach(g => {
            const pipe = pipelineByName.get(String(g.displayName || g.componentName).toLowerCase());
            if (pipe && matched.includes(pipe)) return;
            calledPipelines.push(`<div class="mb-1"><span class="text-primary font-semibold">${nameOf(g)}</span> <span class="text-on-surface-variant">(PIPELINE)</span></div>`);
        });
        if (calledPipelines.length) {
            parts.push(note(isDataFlow ? "Uses a replication pipeline:" : "Calls pipeline:") + calledPipelines.join(""));
        }
        if (!copies.length && !matched.length && !calledPipelines.length) return; // creates no physical artifact
        addRow(c.componentName, c.componentType, parts.join(""), matched);
    });

    // what is left (generic datasets, linked services...) is driven by the configuration, not by one source artifact
    const rest = all.filter(v => !used.has(String(v.resourceName).toLowerCase()));
    if (rest.length) addRow("Generic artifacts (workaround)", "Shared / generic artifacts", rest.map(artifactHtml).join(""), rest);

    const el = sectionShell("artifactMapSection", "Source Artifact to Target Artifact Mapping",
        `<div class="text-[12px] text-on-surface-variant">Only artifacts created as a physical file in the target are listed (pipelines, data flows, datasets, linked services).</div>`);
    if (el) el.appendChild(simpleTable(["Source Artifact", "Target Artifact(s)"], rows, ["50%", "50%"]));
}

function renderConfigMapping(report) {
    const cm = report.configMapping;
    const mappings = cm ? (cm.typeProperties || []).filter(p => p.name === "MAPPING").map(p => p.value.split("|")) : [];
    if (!mappings.length) return;
    const lsTypes = new Map((cm.typeProperties || []).filter(p => p.name === "LINKED_SERVICE").map(p => p.value.split("|")));
    const rows = mappings.map(([dir, dbs, ds, ls, lsKind, srcType]) => `<tr class="hover:bg-surface-container-low">
        ${td(escapeHtml(dbs.split(",").join(", ") || "-"))}${td(escapeHtml(dir))}${td(escapeHtml(ds))}${td(escapeHtml(ls))}
        ${td(escapeHtml(lsTypes.get(ls) || lsKind))}${td(escapeHtml(srcType))}</tr>`);
    const el = sectionShell("configMapSection", "Connection to Dataset and Linked Service Mapping");
    if (el) el.appendChild(simpleTable(["Source Connection Type", "Direction", "Dataset", "Linked Service", "Linked Service Type", "Dataset Format"], rows));
}

// Package connection -> dataset -> linked service (only present when the generator ran with useSourceConnections).
function renderSourceConnections(report) {
    const cm = report.configMapping;
    const rows = cm ? (cm.typeProperties || []).filter(p => p.name === "CONNECTION").map(p => p.value.split("|")) : [];
    if (!rows.length) return;
    const el = sectionShell("sourceConnectionSection", "Source Connections to Dataset and Linked Service",
        `<div class="text-[12px] text-on-surface-variant">One dataset per connection name; connections with the same connection string share one linked service. Credentials are not shown.</div>`);
    if (!el) return;
    el.appendChild(simpleTable(["Connection", "Dataset", "Linked Service", "Linked Service Type", "Connection String"],
        rows.map(([conn, ds, ls, type, cs]) => `<tr class="hover:bg-surface-container-low">${td(escapeHtml(conn))}${td(escapeHtml(ds))}${td(escapeHtml(ls))}${td(escapeHtml(type || "-"))}${td(`<span class="break-all">${escapeHtml(cs || "-")}</span>`)}</tr>`)));
}

// Which dataset / linked service each component and activity uses, and whether it comes from the SSIS connection or
// from a generic dataset / linked service used as a workaround (task with no connection in SSIS, or created by a rule).
const CONNECTION_ORIGINS = {
    SSIS_CONNECTION: { label: "SSIS connection", generic: false, reason: "Made from the connection the SSIS task / component uses." },
    NO_SSIS_CONNECTION: { label: "Generic (workaround)", generic: true, reason: "The SSIS task / component has no connection." },
    FILE_CONNECTION: { label: "Generic (workaround)", generic: true, reason: "The SSIS connection is not a database one (file, Excel, FTP ...)." },
    RULE_CREATED: { label: "Generic (workaround)", generic: true, reason: "Created by a conversion rule - it is not in the SSIS package." },
    STAGING_GENERIC: { label: "Generic (workaround)", generic: true, reason: "Staging dataset; the destination connection is applied on the Copy activity that follows." }
};

function renderConnectionUsage(report) {
    const cm = report.configMapping;
    const rows = cm ? (cm.typeProperties || []).filter(p => p.name === "CONNECTION_USAGE").map(p => p.value.split("|")) : [];
    if (!rows.length) return;
    const generic = rows.filter(r => (CONNECTION_ORIGINS[r[4]] || {}).generic).length;
    const note = `<div class="text-[12px] text-on-surface-variant">${rows.length} use(s) of a dataset / linked service: ${rows.length - generic} from an SSIS connection, ${generic} from a generic dataset / linked service used as a workaround (review those - the task or component has no connection in SSIS, or was created by a rule).</div>`;
    const el = sectionShell("connectionUsageSection", "Connections Used by Components and Activities", note);
    if (!el) return;
    const badge = origin => {
        const o = CONNECTION_ORIGINS[origin] || { label: origin, generic: true, reason: "" };
        const cls = o.generic ? "bg-amber-50 text-amber-900 border-amber-300" : "bg-green-50 text-green-900 border-green-300";
        return `<span class="inline-block rounded border px-1.5 py-0.5 ${cls}" title="${escapeHtml(o.reason)}">${escapeHtml(o.label)}</span>`;
    };
    const dash = v => v ? escapeHtml(v) : `<span class="placeholder-value">-</span>`;
    const sorted = rows.slice().sort((a, b) => ((CONNECTION_ORIGINS[a[4]] || {}).generic ? 1 : 0) - ((CONNECTION_ORIGINS[b[4]] || {}).generic ? 1 : 0) || a[1].localeCompare(b[1]));
    el.appendChild(simpleTable(["Component / Activity", "Type", "SSIS Name", "SSIS Connection", "Dataset", "Linked Service", "Source of the Connection"],
        sorted.map(([kind, name, ssisName, conn, origin, ds, ls]) => `<tr class="hover:bg-surface-container-low">
            ${td(`<span class="font-semibold text-on-surface">${escapeHtml(name)}</span>`)}${td(escapeHtml(kind))}${td(dash(ssisName === name ? "" : ssisName))}
            ${td(dash(conn))}${td(dash(ds))}${td(dash(ls))}${td(`${badge(origin)}<div class="text-on-surface-variant mt-0.5">${escapeHtml((CONNECTION_ORIGINS[origin] || {}).reason || "")}</div>`)}</tr>`)));
}

function renderLinkedServiceUsage(report) {
    const results = report.validationResults || [];
    const cm = report.configMapping;
    const lsTypes = new Map(cm ? (cm.typeProperties || []).filter(p => p.name === "LINKED_SERVICE").map(p => p.value.split("|")) : []);
    const usage = new Map(); // linked service -> { datasets: Set, others: Set }
    results.forEach(v => refsOf(v, "LinkedServiceReference").forEach(ls => {
        if (!usage.has(ls)) usage.set(ls, { datasets: new Set(), others: new Set() });
        (v.resourceType === "DATASET" ? usage.get(ls).datasets : usage.get(ls).others).add(v.resourceName);
    }));
    if (!usage.size) return;
    // pipelines / data flows that use a linked service only through one of its datasets
    results.filter(v => v.resourceType !== "DATASET").forEach(v => refsOf(v, "DatasetReference").forEach(dsName => {
        usage.forEach(u => { if ([...u.datasets].some(d => d.toLowerCase() === dsName.toLowerCase())) u.others.add(v.resourceName); });
    }));
    const list = names => names.size ? [...names].map(n => `<div>${escapeHtml(n)}</div>`).join("") : `<span class="placeholder-value">-</span>`;
    const rows = [...usage.entries()].map(([ls, u]) => `<tr class="hover:bg-surface-container-low">
        ${td(`<span class="font-semibold text-on-surface">${escapeHtml(ls)}</span>`)}${td(escapeHtml(lsTypes.get(ls) || "-"))}
        ${td(list(u.datasets))}${td(list(u.others))}
        ${td(`<span class="font-semibold">${u.datasets.size + u.others.size}</span>`)}</tr>`);
    const note = `<div class="flex items-start gap-2 rounded border border-amber-300 bg-amber-50 text-amber-900 p-3 text-[12px]"><span class="material-symbols-outlined text-[18px]">warning</span><span><strong>Disclaimer:</strong> if a linked service is changed (renamed or replaced), every place that refers to it must be updated as well &mdash; the datasets that use it, and the pipelines and data flows that use those datasets (or the linked service directly) listed below.</span></div>`;
    const el = sectionShell("linkedServiceSection", "Linked Services Used in this Package", note);
    if (el) el.appendChild(simpleTable(["Linked Service", "Type", "Datasets Using It", "Pipelines / Data Flows Using It", "Instances"], rows));
}

function renderValidationSection(validationResults) {
    const section = document.getElementById("validationSection");
    const container = document.getElementById("validationResults");
    const summaryEl = document.getElementById("validationSummary");
    if (!section || !container) return;

    // Toggled via inline style rather than Tailwind's `hidden`/`flex` classes, which are both
    // display utilities and would compete for precedence if applied to the same element.
    if (!validationResults || validationResults.length === 0) {
        section.style.display = "none";
        return;
    }
    section.style.display = "flex";
    container.innerHTML = '';

    // A broken data flow graph (see DataFlowGraphValidator - a component with no incoming/outgoing
    // connection) means the generated artifact can't run at all, which is a more urgent class of
    // problem than a schema nitpick from the Azure SDK's own validate() - surface it ahead of
    // everything else so it's the first thing a developer sees and fixes.
    const isBrokenGraph = v => v.resourceType === "DATAFLOW_GRAPH";
    const failed = validationResults.filter(v => v.conversionStatus === "FAIL").length;
    const broken = validationResults.filter(v => v.conversionStatus === "FAIL" && isBrokenGraph(v)).length;
    const passed = validationResults.length - failed;
    if (summaryEl) {
        summaryEl.textContent = (broken > 0 ? `${broken} broken data flow graph(s) - fix these first. ` : "")
            + `${passed}/${validationResults.length} artifact(s) passed`
            + (failed > 0 ? ` — ${failed} need(s) manual review` : "");
    }

    const wrap = document.createElement('div');
    wrap.className = "overflow-x-auto rounded border border-surface-container bg-surface-container-lowest shadow-sm";
    const table = document.createElement('table');
    table.className = "w-full text-left border-collapse font-mono text-[11px]";
    table.innerHTML = `<thead><tr class="bg-surface-container-high text-on-surface-variant text-[10px] uppercase tracking-wide">
        <th class="py-1.5 px-3">Generated Artifact</th>
        <th class="py-1.5 px-3">Type</th>
        <th class="py-1.5 px-3">Status</th>
        <th class="py-1.5 px-3 w-1/2">Validation Findings</th>
    </tr></thead>`;
    const tbody = document.createElement('tbody');
    tbody.className = "divide-y divide-surface-container";

    // Broken graphs first (they're unrunnable, not just schema-imperfect), then other failures,
    // then passed - each tier alphabetical by resource name.
    const ordered = [...validationResults].sort((a, b) => {
        const rank = v => v.conversionStatus !== "FAIL" ? 2 : isBrokenGraph(v) ? 0 : 1;
        const aRank = rank(a);
        const bRank = rank(b);
        if (aRank !== bRank) return aRank - bRank;
        return String(a.resourceName).localeCompare(String(b.resourceName));
    });

    for (const result of ordered) {
        const isFail = result.conversionStatus === "FAIL";
        const isBroken = isFail && isBrokenGraph(result);
        const statusHtml = isBroken
            ? `<span class="inline-flex items-center gap-1 px-2 py-[2px] rounded bg-red-100 text-error font-bold whitespace-nowrap"><span class="material-symbols-outlined text-[14px]">report</span>Broken Flow</span>`
            : isFail
            ? `<span class="inline-flex items-center gap-1 px-2 py-[2px] rounded bg-red-50 text-error font-semibold whitespace-nowrap"><span class="material-symbols-outlined text-[14px]">error</span>Failed</span>`
            : `<span class="inline-flex items-center gap-1 px-2 py-[2px] rounded bg-emerald-50 text-tertiary font-semibold whitespace-nowrap"><span class="material-symbols-outlined text-[14px]">check_circle</span>Passed</span>`;

        const findingsHtml = (result.messages && result.messages.length > 0)
            ? result.messages.map(m => `<div class="flex items-start gap-1.5 ${isFail ? 'text-red-900' : 'text-on-surface-variant'}"><span class="material-symbols-outlined text-[14px] mt-[1px]">${isFail ? 'error' : 'check'}</span><span>${escapeHtml(m.message)}</span></div>`).join('')
            : `<span class="placeholder-value">No findings</span>`;

        const tr = document.createElement('tr');
        tr.className = "hover:bg-surface-container-low transition-colors" + (isBroken ? " bg-red-50/60 border-l-4 border-l-error" : "");
        tr.innerHTML = `
          <td class="py-1.5 px-3 align-top"><div class="flex flex-col"><span class="font-semibold text-on-surface">${escapeHtml(result.resourceName)}</span><span class="text-on-surface-variant">${escapeHtml(result.jobName)}</span></div></td>
          <td class="py-1.5 px-3 align-top whitespace-nowrap text-primary font-semibold">${escapeHtml(result.resourceType)}</td>
          <td class="py-1.5 px-3 align-top">${statusHtml}</td>
          <td class="py-1.5 px-3 align-top"><div class="flex flex-col gap-1">${findingsHtml}</div></td>`;
        tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    wrap.appendChild(table);
    container.appendChild(wrap);
}

// Builds one accordion tile for a single source component, plus - recursively - a "Nested Flow"
// section inside its own body for any components nested under it (e.g. a DataFlow/ForEach/Until
// activity's own internal components), so nested content sits inside the owning item instead of
// being appended as a separate section elsewhere in the report.
//
// keysInView: the Set of componentKeys currently passing the active filter/search (from
// populateComponentDetails); a nested child only renders if it's in that set. Pass null/undefined
// to render every nested child unconditionally.
function buildComponentTile(currSrcComp, keysInView) {
        if (currSrcComp.componentType) componentTypes.add(currSrcComp.componentType);
        if (currSrcComp.jobType) jobTypes.add(currSrcComp.jobType);
        if (currSrcComp.jobName) jobNames.add(currSrcComp.jobName);

        const sourceMessages = currSrcComp.messages || [];
        const generatedComponents = currSrcComp.generatedComponents || [];
        const typeProperties = mergedTypeProperties(currSrcComp);
        const counts = countBadgesForSrcComponent(currSrcComp);

        const tile = document.createElement('div');
        tile.className = "bg-surface-container-lowest rounded shadow-sm overflow-hidden";

        const header = document.createElement('div');
        header.className = "p-3 bg-surface-container-low grid items-center gap-3 cursor-pointer select-none text-left";
        // chevron + five columns in a fixed 25 / 10 / 25 / 20 / 20 ratio so every tile lines up
        header.style.gridTemplateColumns = "24px 25fr 10fr 25fr 20fr 20fr";

        const chevron = document.createElement('span');
        chevron.className = "material-symbols-outlined text-primary text-[20px] shrink-0";
        chevron.textContent = "chevron_right";

        // Data flows / containers: show how many components sit inside (all nesting levels).
        const countNested = c => (c.nestedComponents || []).reduce((n, x) => n + 1 + countNested(x), 0);
        const innerCount = countNested(currSrcComp);

        const srcWrap = document.createElement('div');
        srcWrap.className = "flex flex-col min-w-0";
        srcWrap.innerHTML = `<span class="componentName font-mono font-bold text-[14px] text-on-surface truncate">${escapeHtml(currSrcComp.componentName)}</span><span class="componentType font-mono text-[11px] text-on-surface-variant">${escapeHtml(currSrcComp.componentType)}${innerCount > 0 ? ` <span class="ml-1 px-1.5 py-[1px] rounded bg-surface-container text-on-surface-variant whitespace-nowrap" title="Components inside this ${escapeHtml(currSrcComp.componentType || "container")}">${innerCount} ${innerCount === 1 ? "component" : "components"}</span>` : ""}</span>`;

        const arrow = document.createElement('span');
        arrow.className = "material-symbols-outlined text-outline text-[16px] justify-self-start";
        arrow.textContent = "trending_flat";

        const genWrap = document.createElement('div');
        genWrap.className = "flex flex-col min-w-0";
        if (generatedComponents.length === 1) {
            // Mirror the source side's name-over-type layout so the generated component's type is
            // just as visible as the adopted one's.
            genWrap.innerHTML = `<span class="componentName font-mono font-bold text-[14px] text-primary truncate">${escapeHtml(generatedComponents[0].displayName || generatedComponents[0].componentName)}</span><span class="componentType font-mono text-[11px] text-on-surface-variant">${escapeHtml(generatedComponents[0].componentType)}</span>`;
        } else if (generatedComponents.length === 0) {
            genWrap.innerHTML = `<span class="placeholder-value font-mono text-[12px]">${NO_GENERATED_COMPONENTS}</span>`;
        } else {
            // Multiple generated components: summarise the count, with the distinct types beneath so
            // the type information is still surfaced here (per-component detail is in the body).
            const distinctTypes = [...new Set(generatedComponents.map(g => g.componentType).filter(Boolean))];
            genWrap.innerHTML = `<span class="componentName font-mono font-bold text-[14px] text-primary">${generatedComponents.length} Generated Components</span><span class="componentType font-mono text-[11px] text-on-surface-variant truncate">${escapeHtml(distinctTypes.join(", "))}</span>`;
        }

        const status = scoreStatus(currSrcComp, counts);
        const pillCell = document.createElement('div');
        pillCell.className = "flex items-center min-w-0";
        pillCell.appendChild(statusPill(counts, status, scoreRow(currSrcComp)));
        const badgeWrap = document.createElement('div');
        badgeWrap.className = "flex items-center gap-1 min-w-0";
        badgeWrap.appendChild(createMsgBadge(counts.errorMessages, "error"));
        badgeWrap.appendChild(createMsgBadge(counts.warnMessages, "warn"));
        badgeWrap.appendChild(createMsgBadge(counts.infoMessages, "info"));
        badgeWrap.appendChild(createMsgBadge(counts.successMessages, "success"));

        header.appendChild(chevron);
        header.appendChild(srcWrap);
        header.appendChild(arrow);
        header.appendChild(genWrap);
        header.appendChild(pillCell);
        header.appendChild(badgeWrap);

        const body = document.createElement('div');
        body.className = "hidden p-4 flex flex-col gap-4 border-t border-surface-container";
        const scored = scoreRow(currSrcComp);
        if (scored) {
            body.appendChild(sectionLabel("Converted Properties"));
            body.appendChild(renderScoreDetails(scored));
        }
        body.appendChild(sectionLabel("Messages"));
        body.appendChild(renderMessageComparison(sourceMessages, generatedComponents));
        if (typeProperties.length > 0) {
            body.appendChild(sectionLabel("Property & Value Mappings"));
            body.appendChild(renderPropertiesPanel(typeProperties));
        }

        const visibleNested = (currSrcComp.nestedComponents || []).filter(c => !keysInView || keysInView.has(c.componentKey));
        if (visibleNested.length > 0) {
            const nestedLabel = document.createElement('div');
            nestedLabel.className = "flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-on-surface-variant";
            nestedLabel.innerHTML = `<span class="material-symbols-outlined text-[14px]">account_tree</span><span>Nested Flow${visibleNested[0].jobName ? ": " + escapeHtml(visibleNested[0].jobName) : ""}</span>`;
            body.appendChild(nestedLabel);

            const nestedWrap = document.createElement('div');
            nestedWrap.className = "ml-2 pl-3 border-l-2 border-surface-container flex flex-col gap-3";
            visibleNested.forEach((child) => {
                nestedWrap.appendChild(buildComponentTile(child, keysInView));
            });
            body.appendChild(nestedWrap);
        }

        header.addEventListener('click', () => {
            const isHidden = body.classList.toggle('hidden');
            chevron.textContent = isHidden ? 'chevron_right' : 'expand_more';
        });

        tile.appendChild(header);
        tile.appendChild(body);
        return tile;
}

// Renders component tiles. Only "top-level" components are appended directly to the accordion -
// everything nested under one (a DataFlow/ForEach/Until activity's own components) renders inside
// that owning tile's own body (see buildComponentTile), not as a separate section here.
//
// A component counts as top-level for THIS render either because it has no owner, or because its
// owner didn't pass the active filter/search (sourceData is already filtered by the caller) - that
// keeps a filtered/searched-for nested component visible even when its parent got filtered out,
// instead of silently disappearing.
function populateComponentDetails(sourceData) {
    const accordion = document.querySelector(".accordion");
    if (!accordion) return;
    accordion.innerHTML = '';

    if (!sourceData || !Array.isArray(sourceData) || sourceData.length === 0) {
        accordion.innerHTML = '<div class="bg-surface-container-lowest rounded p-4 text-on-surface-variant text-center shadow-sm">No components found.</div>';
        return;
    }

    const keysInView = new Set(sourceData.map(c => c.componentKey));
    const topLevel = sourceData.filter(comp => !comp.ownerKey || !keysInView.has(comp.ownerKey));

    if (topLevel.length === 0) {
        accordion.innerHTML = '<div class="bg-surface-container-lowest rounded p-4 text-on-surface-variant text-center shadow-sm">No components found.</div>';
        return;
    }

    topLevel.forEach((currSrcComp) => {
        accordion.appendChild(buildComponentTile(currSrcComp, keysInView));
    });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function load() {
    try {
        if (typeof jobConversionData === 'undefined' || jobConversionData === null) {
            const main = document.querySelector('main');
            if (main) main.innerHTML = '<div class="bg-red-50 text-error rounded p-4">Error: No conversion data available.</div>';
            return;
        }

        let parsedData = jobConversionData;
        if (typeof jobConversionData === 'string') {
            try {
                parsedData = JSON.parse(jobConversionData);
            } catch (e) {
                const main = document.querySelector('main');
                if (main) main.innerHTML = '<div class="bg-red-50 text-error rounded p-4">Error: Invalid JSON data.</div>';
                return;
            }
        }

        const convertedReport = convertJobConversionStatusToReport(parsedData);

        const jobnameEl = document.getElementById("jobname");
        const sourcetoolEl = document.getElementById("sourcetool");
        const targettoolEl = document.getElementById("targettool");
        if (jobnameEl) jobnameEl.textContent = convertedReport.jobName || "Unknown";
        // Package switcher: packages.js (written next to this report) lists every converted package.
        const pkgs = Array.isArray(window.ectPackages) ? window.ectPackages : [];
        if (jobnameEl && pkgs.length > 1) {
            // Searchable package picker: type to filter the list, pick a package to open its report.
            const current = convertedReport.jobName;
            const wrapEl = document.createElement("span");
            const select = document.createElement("input");
            const list = document.createElement("datalist");
            list.id = "packageList";
            pkgs.forEach(p => {
                const opt = document.createElement("option");
                opt.value = p.name;
                list.appendChild(opt);
            });
            select.id = "packageSelect";
            select.type = "text";
            select.value = current;
            select.setAttribute("list", list.id);
            select.title = "Search / switch package";
            select.placeholder = "Search package";
            select.className = "h-7 px-2 rounded border border-surface-container-high bg-surface-container-lowest text-[12px] font-semibold text-on-surface focus:outline-none focus:ring-1 focus:ring-primary w-64";
            // clear on focus so the list is not filtered down to the current package
            select.addEventListener("focus", () => { select.value = ""; });
            select.addEventListener("blur", () => { if (!select.value) select.value = current; });
            select.addEventListener("input", () => {
                const target = pkgs.find(p => p.name === select.value);
                if (target && target.name !== current) {
                    location.href = window.reportMode === "validation" ? target.href.replace(/_report\.html$/, "_validation.html") : target.href;
                }
            });
            wrapEl.appendChild(select);
            wrapEl.appendChild(list);
            jobnameEl.replaceWith(wrapEl);
        }
        const consolidatedLink = document.getElementById("consolidatedLink");
        if (consolidatedLink && window.ectConsolidatedHref) {
            consolidatedLink.href = window.ectConsolidatedHref;
            consolidatedLink.style.display = "flex";
        }
        // clicking the logo goes to the consolidated report
        const logo = document.querySelector('img[alt="Company Logo"]');
        if (logo && window.ectConsolidatedHref && !(logo.parentElement && logo.parentElement.tagName === "A")) {
            const a = document.createElement("a");
            a.href = window.ectConsolidatedHref;
            a.title = "Back to the consolidated report";
            a.className = "inline-flex";
            logo.replaceWith(a);
            a.appendChild(logo);
        }
        if (sourcetoolEl) sourcetoolEl.textContent = convertedReport.sourceToolName || "Unknown";
        if (targettoolEl) targettoolEl.textContent = convertedReport.targetToolName || "Unknown";

        source = Array.isArray(convertedReport.sourceComponents) ? convertedReport.sourceComponents : [];
        source = reorderComponents(source, []);

        const typeSelect = document.getElementById("selectedType");
        const searchInput = document.getElementById("searchTerm");
        if (typeSelect) typeSelect.addEventListener("change", filterData);
        if (searchInput) searchInput.addEventListener("input", filterData);

        // The validation report (validation.html) shares this script but has no component list.
        const validationOnly = window.reportMode === "validation";
        if (!validationOnly) {
            populateComponentDetails(source);
            populateDropdowns();
        }

        const summary = computeOverallSummary(source);
        renderStatusBar(summary);
        if (validationOnly) renderValidationCards(convertedReport.validationResults || []);
        else renderKpiCards(summary);
        if (!validationOnly) renderStatusChips(summary);
        renderValidationSection(convertedReport.validationResults);
        if (validationOnly) {
            renderArtifactMapping(convertedReport);
            renderConfigMapping(convertedReport);
            renderSourceConnections(convertedReport);
            renderConnectionUsage(convertedReport);
            renderLinkedServiceUsage(convertedReport);
        }

        const validationLink = document.getElementById("validationLink");
        if (validationLink && !validationOnly && (convertedReport.validationResults || []).length > 0) {
            validationLink.href = location.pathname.split("/").pop().replace(/\.html$/, "") .replace(/_report$/, "") + "_validation.html";
            validationLink.style.display = "flex";
        }

        const footer = document.getElementById("footerdate");
        if (footer) footer.innerHTML = "&copy; " + new Date().getFullYear() + " Bitwise. Report generated " + new Date().toLocaleString() + ".";
    } catch (error) {
        console.error("Error in load():", error);
        const jobnameEl = document.getElementById("jobname");
        if (jobnameEl) jobnameEl.textContent = "Error loading report: " + error.message;
    }
}

load();
