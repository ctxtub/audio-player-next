export const trackEvent = (
    action: string,
    category: string,
    label?: string,
    value?: number
  ) => {
    try {
      window.gtag('event', action, {
        event_category: category,
        event_label: label,
        value: value,
      });
    } catch (error) {
      console.error('GA tracking error:', error);
    }
  };