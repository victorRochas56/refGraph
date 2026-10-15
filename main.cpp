#include <algorithm>
#include <cctype>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <ostream>
#include <string>
#include <functional>
#include <unordered_map>

                    // symbol -> filepath of all its refs
std::unordered_map<std::string, std::unordered_map<std::filesystem::path, uint32_t>> symbols;

std::string identifier = "struct";

void findDeclarations(const std::filesystem::path& file)
{
    std::ifstream in(file, std::ios::binary);
    if(!in)
        return;

    std::string content((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());

    for(std::size_t pos = content.find(identifier);
        pos != std::string::npos;
        pos = content.find(identifier, pos + identifier.size()))
    {
        int i = 0;
        char c = content.at(pos + identifier.size() + i);
        std::string symbol = "";
        while(c != '\n' && c != ' ' && c != ';' && ((pos + identifier.size() + i + 1) < content.size()))
        {
            symbol += c;
            i++;
            c = content.at(pos + identifier.size() + i);
        }
        if(!symbol.empty() && 
            ((content.at(pos + identifier.size() + i) == ' ' &&
              content.at(pos + identifier.size() + i + 1) == '{') ||
              content.at(pos + identifier.size() + i) == '\n'))
        {   
            symbols[symbol].clear();
        }
    }
}

static bool isIdentChar(char c)
{
    return std::isalnum(static_cast<unsigned char>(c)) || c == '_';
}

void findReferences(const std::filesystem::path& file)
{
    std::ifstream in(file, std::ios::binary);
    if(!in)
        return;

    std::size_t maxLen = 0;
    for(const auto& [symbol, refs] : symbols)
        maxLen = std::max(maxLen, symbol.size());
    if(maxLen == 0)
        return;

    std::string window;
    window.reserve(maxLen + 1);
    std::unordered_map<std::string, std::size_t> counts;

    for(std::istreambuf_iterator<char> it(in), end; it != end; ++it)
    {
        const char c = *it;

        if(c == ' ' || c == '&')
        {
            // A suffix only counts if it starts on a token boundary, so "MyFoo" does not match "Foo".
            // The window keeps one extra char before the longest candidate to check that boundary.
            const std::size_t maxCandidate = std::min(window.size(), maxLen);
            for(std::size_t len = 1; len <= maxCandidate; len++)
            {
                if(len < window.size() && isIdentChar(window[window.size() - len - 1]))
                    continue;

                std::string candidate = window.substr(window.size() - len);
                if(symbols.count(candidate))
                {
                    counts[candidate]++;
                    symbols[candidate][file]++;
                }
            }
        }

        window += c;
        if(window.size() > maxLen + 1)
            window.erase(0, 1);
    }

    for(const auto& [symbol, count] : counts)
    {
        std::cout << symbol << " " << count << " " << file.filename() << std::endl;
    }
}

void runOnFiles(const std::filesystem::path& dir, std::function<void(const std::filesystem::path&)> fileFn)
{
    std::error_code ec;

    std::filesystem::recursive_directory_iterator it(
        dir, std::filesystem::directory_options::skip_permission_denied, ec);

    for(; it != std::filesystem::recursive_directory_iterator(); it.increment(ec))
    {
        if(ec)
        {
            ec.clear();
            continue;
        }
        if(it->is_regular_file(ec))
            fileFn(it->path());
    }
}

int main(int argc, char* argv[])
{

    if(argc != 4)
    {
        std::cerr << "usage: " << argv[0] << " <directory> <identifier> <declaration_seperator>\n";
        return 1;
    }

    std::string path(argv[1]);
    identifier = argv[2];
    identifier += argv[3];

    std::filesystem::path targetPath = std::filesystem::current_path() / path;

    if(!std::filesystem::is_directory(targetPath))
    {
        std::cerr << targetPath << " is not a directory\n";
        return 1;
    }

    runOnFiles(targetPath, findDeclarations);
    runOnFiles(targetPath, findReferences);

    return 0;
}
