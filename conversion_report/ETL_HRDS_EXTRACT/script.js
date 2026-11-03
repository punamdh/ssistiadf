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
            jobStatus.components.forEach((component) => {
                const thisJobName = jobStatus.name || parentJobName || "Unknown Job";
                allComponents.push({
                    ...component,
                    jobType: jobStatus.jobType || parentJobType || "UNKNOWN",
                    jobName: thisJobName,
                    depth: depth,
                    ownerKey: ownerKey || null
                });
                const isAdoptionSide = component.source === "COMPONENT_ADOPTION" || component.source === "ACTIVITY_ADOPTION" || !component.source;
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

    allComponents.forEach((component, index) => {
        const componentSource = component.source;
        if (!component.name) return;

        if (componentSource === "COMPONENT_ADOPTION" || componentSource === "ACTIVITY_ADOPTION" || !componentSource) {
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
                messages: convertMessages(component.messages || [])
            };
        }
    });

    generatedComponents.forEach((genComp) => {
        // Prefer matching the generated entry to the adopted entry of the SAME name first - that's
        // the entry a rule creates for itself (e.g. a Script/SetVariable activity, or an If Condition
        // wrapper, a rule derives from an original task) and it's always the right match when it
        // exists. Only fall back to matching via .parent when no same-named adopted entry exists:
        // that covers an ECTFlow/SubControlFlow activity (whose .parent names its OUTER container,
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
        sourceComponentsMap[key].generatedComponents.push({
            componentName: genComp.componentName,
            displayName: genComp.displayName,
            componentType: genComp.componentType,
            messages: genComp.messages,
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
                    (g) => g.componentName === gen.componentName && g.componentType === gen.componentType
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
        if (comp.ownerKey && sourceComponentsMap[comp.ownerKey]) {
            sourceComponentsMap[comp.ownerKey].nestedComponents.push(comp);
        }
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
        validationResults: Object.values(validationResultsMap)
    };
}

function convertMessages(messages) {
    if (!messages || !Array.isArray(messages) || messages.length === 0) return [];
    const converted = messages.map(msg => ({
        message: msg.message || "No message",
        messageCategory: convertPriorityToCategory(msg.messageType)
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

    if (counts.errorMessages > 0) failedComponents.add(currSrcComp.componentId);
    else if (counts.warnMessages > 0) warningComponents.add(currSrcComp.componentId);
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

        if (counts.errorMessages > 0) summary.errorComponents++;
        else if (counts.warnMessages > 0) summary.warnComponents++;
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

function renderStatusBar(summary) {
    const bar = document.getElementById("statusBar");
    if (!bar) return;
    let label, dot, textColor, bg;
    if (summary.errorComponents > 0) { label = "Completed with Errors"; dot = "bg-error"; textColor = "text-error"; bg = "bg-red-50"; }
    else if (summary.warnComponents > 0) { label = "Completed with Warnings"; dot = "bg-amber-500"; textColor = "text-amber-700"; bg = "bg-amber-50"; }
    else { label = "Completed Successfully"; dot = "bg-tertiary"; textColor = "text-tertiary"; bg = "bg-emerald-50"; }
    const successPct = summary.totalComponents ? Math.round((summary.successComponents / summary.totalComponents) * 1000) / 10 : 0;
    bar.innerHTML = `<span class="inline-flex items-center gap-1 px-2 py-[3px] rounded ${bg} ${textColor} font-mono text-[12px] font-semibold"><span class="w-2 h-2 rounded-full ${dot}"></span>${label}</span>
        <span class="font-mono text-[12px] text-on-surface-variant">${successPct}% of components clean (no errors/warnings)</span>`;
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

    const successPct = summary.totalComponents ? Math.round((summary.successComponents / summary.totalComponents) * 1000) / 10 : 0;
    const propsPct = summary.propsTotal ? Math.round((summary.propsMapped / summary.propsTotal) * 1000) / 10 : null;
    const totalMsgs = summary.totalMessages.error + summary.totalMessages.warn + summary.totalMessages.info + summary.totalMessages.success;

    container.appendChild(kpiCard("Total Components", summary.totalComponents, "Converted",
        `<div class="flex items-center gap-3 text-[11px] font-mono text-on-surface-variant"><span>Success: <strong class="text-tertiary">${summary.successComponents}</strong></span><span>Warnings: <strong class="text-amber-600">${summary.warnComponents}</strong></span><span>Errors: <strong class="text-error">${summary.errorComponents}</strong></span></div>`));

    container.appendChild(kpiCard("Component Success Rate", successPct + "%", "No warnings/errors",
        `<div class="text-[12px] text-on-surface-variant">Based on ${summary.totalComponents} converted component(s).</div>`));

    container.appendChild(kpiCard("Message Diagnostics", totalMsgs, "Messages Logged",
        `<div class="flex items-center gap-2 text-[11px] font-mono"><span class="px-1.5 py-[1px] rounded bg-red-50 text-error">${summary.totalMessages.error} Errors</span><span class="px-1.5 py-[1px] rounded bg-amber-50 text-amber-700">${summary.totalMessages.warn} Warnings</span><span class="px-1.5 py-[1px] rounded bg-surface-container text-on-surface-variant">${summary.totalMessages.info} Info</span></div>`));

    container.appendChild(kpiCard("Properties Compared", summary.propsTotal ? (summary.propsMapped + "/" + summary.propsTotal) : "—",
        propsPct !== null ? propsPct + "% Mapped" : "Not tracked for these component types",
        `<div class="text-[12px] text-on-surface-variant">Adopted vs. generated property values, where tracked.</div>`));
}

function renderStatusChips(summary) {
    const container = document.getElementById("statusChips");
    if (!container) return;
    container.innerHTML = '';
    const chips = [
        { key: "All", label: "All", count: summary.totalComponents, dot: "bg-outline" },
        { key: "Error", label: "Manual Review", count: summary.errorComponents, dot: "bg-error" },
        { key: "Warning", label: "Warnings", count: summary.warnComponents, dot: "bg-amber-500" },
        { key: "Success", label: "Success", count: summary.successComponents, dot: "bg-tertiary" }
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

function statusPill(counts) {
    const span = document.createElement('span');
    let label, cls;
    if (counts.errorMessages > 0) {
        label = `Manual Review (${counts.errorMessages} Error${counts.errorMessages > 1 ? 's' : ''})`;
        cls = "bg-red-50 text-error";
    } else if (counts.warnMessages > 0) {
        label = `Converted with Warnings (${counts.warnMessages})`;
        cls = "bg-amber-50 text-amber-700";
    } else {
        label = "Converted Successfully";
        cls = "bg-emerald-50 text-tertiary";
    }
    span.className = `px-2 py-[2px] rounded font-mono text-[11px] font-semibold whitespace-nowrap ${cls}`;
    span.textContent = label;
    return span;
}

function createMsgBadge(count, msgType) {
    const span = document.createElement('span');
    const styles = {
        error: "bg-red-50 text-error", warn: "bg-amber-50 text-amber-700",
        info: "bg-sky-50 text-sky-700", success: "bg-emerald-50 text-tertiary"
    };
    span.className = `px-1.5 py-[1px] rounded font-mono text-[10px] font-semibold ${styles[msgType] || ''} ${count === 0 ? 'opacity-40' : ''}`;
    span.textContent = count;
    span.title = msgType + " messages";
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
        Warning: ["warning", "bg-amber-50 text-amber-900"],
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
        header.className = "p-3 bg-surface-container-low flex flex-col md:flex-row md:items-center justify-between gap-2 cursor-pointer select-none";

        const left = document.createElement('div');
        left.className = "flex items-center gap-2 min-w-0";

        const chevron = document.createElement('span');
        chevron.className = "material-symbols-outlined text-primary text-[20px] shrink-0";
        chevron.textContent = "chevron_right";
        left.appendChild(chevron);

        const namesWrap = document.createElement('div');
        namesWrap.className = "flex items-center gap-2 min-w-0 flex-wrap";

        const srcWrap = document.createElement('div');
        srcWrap.className = "flex flex-col min-w-0";
        srcWrap.innerHTML = `<span class="componentName font-mono font-bold text-[14px] text-on-surface truncate">${escapeHtml(currSrcComp.componentName)}</span><span class="componentType font-mono text-[11px] text-on-surface-variant">${escapeHtml(currSrcComp.componentType)}</span>`;
        namesWrap.appendChild(srcWrap);

        const arrow = document.createElement('span');
        arrow.className = "material-symbols-outlined text-outline text-[16px]";
        arrow.textContent = "trending_flat";
        namesWrap.appendChild(arrow);

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
        namesWrap.appendChild(genWrap);

        left.appendChild(namesWrap);

        const right = document.createElement('div');
        right.className = "flex items-center gap-2 flex-wrap";
        right.appendChild(statusPill(counts));
        const badgeWrap = document.createElement('div');
        badgeWrap.className = "flex items-center gap-1";
        badgeWrap.appendChild(createMsgBadge(counts.errorMessages, "error"));
        badgeWrap.appendChild(createMsgBadge(counts.warnMessages, "warn"));
        badgeWrap.appendChild(createMsgBadge(counts.infoMessages, "info"));
        badgeWrap.appendChild(createMsgBadge(counts.successMessages, "success"));
        right.appendChild(badgeWrap);

        header.appendChild(left);
        header.appendChild(right);

        const body = document.createElement('div');
        body.className = "hidden p-4 flex flex-col gap-4 border-t border-surface-container";
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
        if (sourcetoolEl) sourcetoolEl.textContent = convertedReport.sourceToolName || "Unknown";
        if (targettoolEl) targettoolEl.textContent = convertedReport.targetToolName || "Unknown";

        source = Array.isArray(convertedReport.sourceComponents) ? convertedReport.sourceComponents : [];
        source = reorderComponents(source, []);

        const typeSelect = document.getElementById("selectedType");
        const searchInput = document.getElementById("searchTerm");
        if (typeSelect) typeSelect.addEventListener("change", filterData);
        if (searchInput) searchInput.addEventListener("input", filterData);

        populateComponentDetails(source);
        populateDropdowns();

        const summary = computeOverallSummary(source);
        renderStatusBar(summary);
        renderKpiCards(summary);
        renderStatusChips(summary);
        renderValidationSection(convertedReport.validationResults);

        const footer = document.getElementById("footerdate");
        if (footer) footer.innerHTML = "&copy; " + new Date().getFullYear() + " Bitwise. Report generated " + new Date().toLocaleString() + ".";
    } catch (error) {
        console.error("Error in load():", error);
        const jobnameEl = document.getElementById("jobname");
        if (jobnameEl) jobnameEl.textContent = "Error loading report: " + error.message;
    }
}

load();
