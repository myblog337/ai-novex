import React from 'react';
import { Hero } from '../components/Hero';
import { CategoryGrid } from '../components/CategoryGrid';
import { FeaturedTools } from '../components/FeaturedTools';
import { BlogSection } from '../components/BlogSection';
import { Tool, Category, Article } from '../types';

interface HomeViewProps {
  categories: Category[];
  tools: Tool[];
  articles: Article[];
  onNavigate: (path: string) => void;
  onSelectTool: (tool: Tool) => void;
}

export const HomeView: React.FC<HomeViewProps> = ({
  categories,
  tools,
  articles,
  onNavigate,
  onSelectTool,
}) => {
  const featuredTools = tools.filter((t) => t.isFeatured).slice(0, 5);

  return (
    <div>
      {/* Hero with glowing orbital sphere */}
      <Hero
        onSearch={(query) => onNavigate(`/tools/?q=${encodeURIComponent(query)}`)}
        onTagClick={(path) => onNavigate(path)}
      />

      {/* Browse by Category */}
      <CategoryGrid
        categories={categories}
        onSelectCategory={(slug) => onNavigate(`/category/${slug}/`)}
        onViewAll={() => onNavigate('/categories/')}
      />

      {/* Featured AI Tools */}
      <FeaturedTools
        tools={featuredTools.length > 0 ? featuredTools : tools.slice(0, 5)}
        onViewAll={() => onNavigate('/tools/')}
        onSelectTool={onSelectTool}
      />

      {/* Latest Blog & News */}
      <BlogSection
        articles={articles}
        onSelectArticle={(slug) => onNavigate(`/blog/${slug}/`)}
        onViewAll={() => onNavigate('/blog/')}
        onExploreTools={() => onNavigate('/tools/')}
      />
    </div>
  );
};
