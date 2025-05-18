// --- NEW: Main Navigation Dropdown Logic ---
function initMainNavigation() {
  const navDropdownItems = document.querySelectorAll('.main-navigation-dropdown-container .dropdown-item.nav-dropdown-item');
  const dropdownButtonTextSpan = document.getElementById('selected-feature-name');
  const leftPanelContainer = document.querySelector('aside.left-panel');
  const rightPanelContainer = document.querySelector('main.right-panel');

  // Check if essential elements exist
  if (!navDropdownItems.length || !dropdownButtonTextSpan || !leftPanelContainer || !rightPanelContainer) {
    console.warn("Main navigation UI elements missing for initMainNavigation.");
    if (dropdownButtonTextSpan) dropdownButtonTextSpan.innerHTML = `<i class="fas fa-exclamation-triangle me-2"></i> Nav Error`;
    return;
  }

  // Switch to active feature and update UI accordingly
  function switchActiveFeature(featureKey) {
    let newButtonText = "选择功能"; 
    let newButtonIconHTML = '<i class="fas fa-bars me-2"></i>'; 

    // Deactivate previous content
    leftPanelContainer.querySelectorAll('.feature-content-block').forEach(content => content.classList.remove('active'));
    rightPanelContainer.querySelectorAll('.feature-content-block').forEach(content => content.classList.remove('active'));
    navDropdownItems.forEach(item => item.classList.remove('active'));

    // Find and activate the target content blocks
    const targetLeftPanelContent = document.getElementById(`left-panel-${featureKey}`);
    const targetRightPanelContent = document.getElementById(`right-panel-${featureKey}`);
    const targetNavItem = Array.from(navDropdownItems).find(item => item.dataset.feature === featureKey);

    if (targetLeftPanelContent && targetRightPanelContent && targetNavItem) {
      targetLeftPanelContent.classList.add('active');
      targetRightPanelContent.classList.add('active');
      targetNavItem.classList.add('active'); 
      
      newButtonText = targetNavItem.textContent.trim();
      const iconEl = targetNavItem.querySelector('i.fas');
      newButtonIconHTML = iconEl ? iconEl.outerHTML + " " : "";
    } else {
      console.warn(`Content blocks or nav item not found for feature: ${featureKey}. Defaulting if possible.`);
      if (navDropdownItems.length > 0 && navDropdownItems[0].dataset.feature) {
        const firstFeatureKey = navDropdownItems[0].dataset.feature;
        document.getElementById(`left-panel-${firstFeatureKey}`)?.classList.add('active');
        document.getElementById(`right-panel-${firstFeatureKey}`)?.classList.add('active');
        navDropdownItems[0].classList.add('active');
        newButtonText = navDropdownItems[0].textContent.trim();
        const iconEl = navDropdownItems[0].querySelector('i.fas');
        newButtonIconHTML = iconEl ? iconEl.outerHTML + " " : "";
        featureKey = firstFeatureKey; 
      }
    }
    
    dropdownButtonTextSpan.innerHTML = `${newButtonIconHTML}${newButtonText}`;
    if (featureKey === 'ai-chat') document.getElementById('chat-chat-input')?.focus();
    localStorage.setItem(ACTIVE_MAIN_FEATURE_TAB_KEY, featureKey);
    console.log(`Switched to main feature: ${featureKey}`);
  }

  // Event listener for dropdown item clicks
  navDropdownItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const featureKey = item.dataset.feature; 
      if (featureKey) switchActiveFeature(featureKey);
    });
  });

  // Initialize with the last active feature or default feature
  const lastActiveFeature = localStorage.getItem(ACTIVE_MAIN_FEATURE_TAB_KEY);
  let initialFeatureKey = null;
  const activeHTMLNavItem = Array.from(navDropdownItems).find(item => item.classList.contains('active'));

  if (activeHTMLNavItem && activeHTMLNavItem.dataset.feature) initialFeatureKey = activeHTMLNavItem.dataset.feature;
  else if (lastActiveFeature && Array.from(navDropdownItems).find(item => item.dataset.feature === lastActiveFeature)) initialFeatureKey = lastActiveFeature;
  else if (navDropdownItems.length > 0 && navDropdownItems[0].dataset.feature) initialFeatureKey = navDropdownItems[0].dataset.feature;

  if (initialFeatureKey) switchActiveFeature(initialFeatureKey);
  else if (dropdownButtonTextSpan) dropdownButtonTextSpan.innerHTML = `<i class="fas fa-exclamation-triangle me-2"></i> 无功能`;
}
